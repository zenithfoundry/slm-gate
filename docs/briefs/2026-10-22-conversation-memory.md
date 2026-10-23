# Brief: a rolling conversation memory, built by the model gate

Date: 2026-10-22. Author: Claude (Fable 5.1) after the 2026-10-21 batch landed on `feat/get-local-models-to-do-more`.
Audience: `/tls:reflexion-loop-sub-max` (plan hardening, Codex critic), then `/tls:dev-team-sub-max`.
Owner: bronz3beard. The owner reviews every diff and commits; agents never stage, commit or push.

## 1. The problem, in one paragraph

Every local step in slm-gate answers from a single message. The model gate hands Step A one typed message; the
MCP gate hands `ask_elision` a question and the elided text, and the resolver a skill and a task string. None of
them knows what the conversation is about, what was decided three turns ago, or which files are in play. That is
why a local first answer to a coding tool was wrong twice on 2026-10-22 ("I don't have context about Part 1"),
why the resolver asks generic questions, and why `ask_elision` cannot tell which part of a skill matters now.
The model gate already receives the whole conversation on every request (a coding tool resends its full history;
today's requests averaged 70k tokens), so the context exists. What is missing is a form of it a small model can
hold: a few hundred tokens, kept current, per conversation.

## 2. Facts established (read-only, 2026-10-22)

| Fact | Value | Where |
|---|---|---|
| The model gate sees the full history every request | `listToolResults`, `typedTurnText`, `firstRequestPrompt` all read `body.messages` | `src/llm-gate/formats/anthropic.ts` |
| A conversation is already keyed | `conversationKey(body)` = sha256 of the first user message | `src/llm-gate/distill.ts:120` |
| Only new turns are ever touched | the "history" rule: a result the provider has seen is never altered | `distill.ts:5-10`, outcome `history` |
| Request rate | peaks of 15–16 requests per minute during agentic work; 452 forwarded today | ledger, `layer='llm'`, 2026-10-22 |
| Typed turns are a small share | per-turn classification is off (`ROUTING_TUNE=off`), so no count yet; most requests end in a tool result | `meta.category_outcome` null on all 496 rows |
| Local window | `NUM_CTX=8192`; the brain is `qwen3.5:4b`, the gate `qwen3.5:2b`, both pinned | `.env`, `src/models/pin.ts` |
| Every local call is bounded | `generateJSON`: native structured output, `num_predict` 2000, `withSlmTimeout` | `src/models/slm.ts:35`, `src/models/helpers.ts` |
| The MCP gate knows no conversation | a tool call carries `rootUri` (workspace) and, if the client sends one, `args.sessionId`; Claude Code sends neither a conversation id nor the first message | `src/mcp-gate/pipeline.ts:133`, `server.ts` |
| The two gates are separate processes sharing one SQLite file | ledger `events`, `cache`, `elision_cache`, `condition_deps`, … | `src/ledger/index.ts` |
| `events.meta` is mirrored to Langfuse in full | `formatEventForLangfuse` spreads `parsedMeta` into `metadata` | `src/ledger/index.ts` (metadata block) |
| Nothing in the ledger is purged automatically | owner rule; `elision:clean` is the owner's command | `scripts/elision-clean.mjs` |
| Step A is off by default since 2026-10-22 | `LLM_GATE_LOCAL_FIRST=off`; the verifier now rejects "I don't have context" | `src/config.ts:96`, `src/verifier/index.ts` |
| Decision memory and the repo index exist | `src/resolver/decisions.ts`, `src/index/repo-index.ts`, `condition_deps` cache dependencies | this branch |

## 3. Design

### 3.1 What the memory is

One row per conversation in a new ledger table, `conversation_memory`:

```sql
CREATE TABLE IF NOT EXISTS conversation_memory (
  key TEXT PRIMARY KEY,          -- conversationKey(body): sha256 of the first user message
  root TEXT,                     -- the workspace the conversation is about, when the request names one (3.4)
  summary TEXT NOT NULL,         -- the running summary, ≤ MEMORY_MAX_TOKENS (default 400)
  turns INTEGER NOT NULL,        -- how many history entries the summary covers
  folded_at TEXT NOT NULL,       -- ISO time of the last fold
  prompt_version TEXT NOT NULL   -- PROMPT_VERSION the summary was written under
);
```

The summary is plain text with three labelled parts the brain model is told to keep: **Goal** (what the person is
trying to do), **Decided** (choices made, with the turn they were made), **In play** (files, commands, names that
keep coming up). It is written for a 2B to 4B reader: short lines, exact names, no prose.

### 3.2 How it is built: fold, don't re-read

The model gate folds the memory **incrementally** so the brain never reads the whole history:

1. On each forwarded request, after the response has been sent (never on the request path), the gate compares
   `history.length` with `turns` for this key. If there are new entries, it takes **only those entries** (typed
   user text, assistant text, and for tool results the tool name plus the first 200 characters), plus the
   previous summary, and asks the brain for the new summary. Input is capped at `MEMORY_FOLD_INPUT_TOKENS`
   (default 3000); older new entries are dropped first, never the previous summary.
2. One brain call per fold, `generateJSON` with a schema `{ goal, decided: string[], inPlay: string[] }`, the
   standard ceiling and `SLM_TIMEOUT_MS`. The result is rendered to the three-part text and trimmed to
   `MEMORY_MAX_TOKENS`.
3. **Debounce.** At most one fold per conversation per `MEMORY_FOLD_INTERVAL_MS` (default 20000). Requests
   inside the interval only mark the conversation dirty; the next tick folds everything new since the last fold
   in one call. At 15 requests a minute this is 3 brain calls a minute at most, and far fewer when the person is
   reading.
4. **One at a time.** Folds run through a single in-process queue so two conversations never compete on the GPU
   with each other or with a distillation in flight; a fold that would start while a distillation is running
   waits for it.
5. **Failure.** A fold that errors or times out leaves the previous summary and `turns` unchanged; the next tick
   tries again. A summary is never partially written.

### 3.3 Who reads it, and how

| Reader | Today | With memory | Where |
|---|---|---|---|
| `ask_elision` | question + chunk | `Conversation so far:\n<summary>\n\n` prepended to the prompt, so "which step applies here?" has a here | `src/mcp-gate/server.ts`, `answerFromText` |
| resolver, `extractAmbiguities` | skill + task string | the summary beside the task, so the brain lists decisions that matter to this conversation and skips ones already made | `src/resolver/index.ts` |
| decision memory, `decisionAnswer` | question + decision file | unchanged (a decision file answers itself); the summary's **Decided** lines are offered to `gateDecisions` as already-made answers with `source: 'conversation'`, confidence 0.6, never auto-applied | `src/resolver/decisions.ts`, `index.ts` |
| Step A (when `LLM_GATE_LOCAL_FIRST=on`) | typed message | the summary as a system line above the message; the verifier still runs; Step A stays off by default and off for coding tools | `src/llm-gate/local-first.ts` |
| the person | nothing | `slm-gate memory` prints the current summaries (key, root, folded_at, text) so what the local model believes is inspectable | `src/cli.ts` |

The MCP gate cannot know which conversation a tool call belongs to (fact table). It picks the memory for the
tool call's `rootUri` with the most recent `folded_at`, and only if that is within `MEMORY_MATCH_WINDOW_MS`
(default 10 minutes); otherwise it proceeds exactly as today. The risk that two sessions in the same repo
cross is stated in the plan and in `meta.memory.match` on the condition row (`exact` when the client sent a
session id that matches, `root-recent` for the heuristic, `none`).

### 3.4 Where `root` comes from

The model gate does not change the request, but it may read it. Claude Code's system prompt states the working
directory; other tools state a cwd in their first message or not at all. `root` is extracted by a pure function
per wire format (`workspaceOf(body): string | null`), null when absent. Memory rows with null `root` are read
only by the model gate (Step A), never matched by the MCP gate.

### 3.5 What this is not

- It never changes the bytes forwarded to a provider. Byte-stability and prompt caches are untouched.
- It never reaches Langfuse. The summary lives in its own table; event rows carry only `meta.memory =
  { turns, folded_at, match }`, never the text (every `meta` field is mirrored to Langfuse).
- It is never required. Every reader works as today when there is no memory, the memory is stale, or
  `CONVERSATION_MEMORY=off`.
- It is not a cache of answers and not an embedding store. No third model, FTS or exact keys only.

## 4. Slices, in order

| # | Slice | Setting | Done when |
|---|---|---|---|
| 1 | Table, fold function, debounce queue, `meta.memory` on llm rows, `slm-gate memory` | `CONVERSATION_MEMORY=on` (default off) | after a fresh Claude Code session of 5 turns, `slm-gate memory` prints a summary whose **In play** names a real file from the session; one fold per 20 s at most (ledger `meta.memory.folded = 1` count ≤ session seconds / 20) |
| 2 | `workspaceOf` per format; `root` filled | none | `sqlite3 "select root from conversation_memory"` shows the repo path for a Claude Code session |
| 3 | `ask_elision` reads the memory | `PROMPT_VERSION` bump | the `ask-elision` tests pass with and without a memory row; a question that depends on the session ("which step are we on?") answers from the summary |
| 4 | resolver reads the memory; **Decided** lines offered to the gate | `PROMPT_VERSION` bump | a question already answered in the summary is not asked again; test with a scripted brain |
| 5 | Step A reads the memory (behind the existing switch, still off by default) | none | Step A server test with memory: the prompt the brain receives contains the summary |
| 6 | docs: configuration keys, daily-use ("what the local model remembers"), setups page, agent-setup prompt list | none | docs tests pass; every new key listed once |

## 5. Options considered and rejected

- *Re-summarise the whole history each turn.* Rejected: 70k tokens through a 4B model is a minute per request;
  folding new turns only keeps every call under 3k input tokens.
- *Fold on the request path.* Rejected: it would add seconds to every forwarded request for nothing the cloud
  model needs.
- *Store the summary in `events.meta`.* Rejected: `meta` is mirrored to Langfuse in full; conversation text
  must stay on this machine.
- *Embeddings to match tool calls to conversations.* Rejected: a third model; exact key and recency are enough
  and their failure mode is stated.
- *Have the MCP gate build the memory.* Rejected: it never sees the conversation, only tool results.
- *Make Step A on by default once memory exists.* Rejected: a coding tool's helper requests still assume context
  the local model never gets in full; memory narrows the gap, it does not close it. Owner may turn it on.

## 6. Constraints the plan must respect

1. The owner reviews every diff and commits. Agents never stage, commit or push. One branch, one PR.
2. Never purge data: no deleting ledger rows, caches, elisions or memory rows. Hand destructive commands to the owner.
3. Never pull or require a third model. Memory uses the brain model only.
4. The model gate never changes a forwarded request and never adds to the system prompt. Reading the request is allowed.
5. All local-model JSON uses native structured outputs (`format: jsonSchema`), never markdown extraction.
6. Every local-model call has a token ceiling and a timeout. Folds run off the request path, one at a time, debounced.
7. Distillation decisions stay byte-stable per conversation; memory never touches them.
8. Any change to what a local step produces for the cloud model (resolver output, `ask_elision` answers) bumps `PROMPT_VERSION`.
9. Fail closed: no memory, stale memory, a failed fold, or `CONVERSATION_MEMORY=off` means today's behaviour exactly.
10. Conversation text never leaves the machine: not in `events.meta`, not in Langfuse, not in logs beyond a length.
11. macOS and Linux only. Node 22+, pnpm 10+. Jest; `pnpm run build` and `pnpm test` stay green after every slice.
12. Plain wording in docs and comments; questions to the owner are yes/no or pick-one.
