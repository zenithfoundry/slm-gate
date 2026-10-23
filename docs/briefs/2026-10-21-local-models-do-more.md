# Brief: make the local models do more, measurably, without hurting output quality

Date: 2026-10-21. Author: Claude (Fable 5.1) in `/tls:ask`, read-only analysis plus three config edits.
Audience: `/tls:reflexion-loop-sub-max` (plan hardening), then `/tls:dev-team-sub-max` (implementation).
Owner: bronz3beard. The owner reviews every diff and commits; agents never stage, commit or push.

---

## 0. Direction for `/tls:reflexion-loop-sub-max`

Invoke with this file as the spec:

```text
/tls:reflexion-loop-sub-max
story: Harden an implementation plan for docs/briefs/2026-10-21-local-models-do-more.md.
Produce vertical slices in the order of section 4, each with a done-condition that is a command
and its expected output, and name the tests each slice adds. Respect every constraint in section 6.
```

What the loop should do with it:

- **Pre-flight contract.** Writer = Claude (Fable 5.1 or Opus 5.5, whichever the harness runs). Critic = Codex (`codex exec`, Rung X, L0 cross-vendor) through the probe: `node scripts/resolve-critic.mjs --writer anthropic --writer-model <writer-model>` in the stack repo, or `./.ai/rtk-run run resolve-critic ...`. The owner has Codex on ChatGPT Go, so Rung X is available. Do not fall through to a same-model critic without printing the STATE 2 disclosure.
- **Phase 0 discovery is already done.** Sections 1 to 3 are the findings. Copy the facts you rely on into `.loop-out/<runId>/findings.md` instead of re-deriving them, and record options rejected with reasons (section 5 lists several).
- **Output.** A plan under `.loop-out/<runId>/` with: slices in order, each slice's files, snippet, test, done-condition, and rollback. The verdict's first line must be one of the three end states.
- **Turn budget.** 12 turns. The critic prompt is plan plus rubric plus this brief's section 6 only.
- **Hand-off.** After a PASS verdict, the owner runs `/tls:dev-team-sub-max` on the plan. All slices land on one branch as one PR (owner's rule).

---

## 1. What slm-gate is, in one paragraph

A local pre-processing layer in front of cloud coding models. Layer 1 (`mcp-gate`) sits between the IDE and the `tech-lead-stack` toolbox and conditions skill text with a local model before the cloud model reads it. Layer 2 (`llm-gate`, the model gate, port 8787) is an HTTP proxy the coding tool sends its model requests to; it can answer a conversation's first message locally (Step A) and shrinks large Bash, Grep and Glob results before forwarding (Step B). Everything is recorded in a SQLite ledger (`output/ledger.sqlite`) and mirrored to Langfuse. Architecture direction: API-first (`ARCHITECTURE.md`). Two local models via Ollama: brain `qwen3.5:4b` (hard, rare work) and gate `qwen2.5-coder:3b` (cheap, frequent work).

---

## 2. Facts established (ledger and config, read-only, 2026-09-13 to 2026-10-21)

| Fact | Value | Where |
|---|---|---|
| Real model-gate rows | 8, all `forward_raw`, last one 2026-09-23 | `events` where `layer='llm'` and `environment != 'bench'` |
| Model-gate rows that look like savings | 480 `forward_compressed` + 281 `defer_local`, all `environment='bench'` from 2026-09-17 | excluded from the dashboard |
| Coding tools pointed at the gate | none: no `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, shell or env; no `model_provider` in `~/.codex/config.toml` | gate is running (pid 11077) but idle |
| Real savings source | MCP skill conditioning only: 420 rows, 1.21M tokens "saved" | `route='condition'` |
| Skill cut mechanism | `DISTILL_SKILLS=off` forces verbatim ([elision.ts:416](../../src/utils/elision.ts#L416)); hard cut keeps first 70 + last 70 lines over 2,000 tokens ([elision.ts:583](../../src/utils/elision.ts#L583)); no model involved | the `ask` skill arrives with lines 70 to 263 removed |
| Expansions | 239 `expand_elision` calls per 300 conditionings in 30 days; one region re-fetched 81 times; each page up to 2,000 tokens plus a full cloud turn | `route='feedback'`, scored 0 by [ledger/index.ts:386](../../src/ledger/index.ts#L386) |
| Cache | exact cache hit on 330 of 420 conditionings (zero model work); 42 distinct skill texts | `cache` table, key includes `PROMPT_VERSION` |
| Resolver | runs on the 90 misses; 11 `format` and 3 `timeout` failures; questions are generic ("refactor the monolith") because evidence is "guess a filename, read 50 lines" | [resolver/index.ts](../../src/resolver/index.ts) |
| Minutes formula | 300 min / 2.3M tokens = 1 min per 7,667 tokens; best day 58k tokens = 7.6 min; 165 min total over 75 cycles | [providers.ts](../../src/pricing/providers.ts) `minutesFreed` |
| Hardware | Apple M4 Pro, 24 GB unified memory, 20 GPU cores, 14 CPU cores (10P + 4E) | `system_profiler` |
| Loaded models | qwen3.5:4b (3.2 GB VRAM) + qwen2.5-coder:3b (2.3 GB), `NUM_CTX=8192`, `OLLAMA_MAX_LOADED_MODELS=2` | `ollama ps` |
| Also pulled | qwen3.5:2b (2.7 GB Q8), qwen3.5:9b (6.6 GB), qwen2.5-coder:0.5b | `ollama list` |
| Embedding model | `nomic-embed-text` is configured by default but deliberately NOT pulled: loading it evicts one of the two working models (`OLLAMA_MAX_LOADED_MODELS=2`). `SEMCACHE` and `DISTILL_ADAPTIVE` are off and need it | owner decision: never pull it |
| FTS5 | available in the bundled `better-sqlite3` (SQLite 3.53.4), verified | `CREATE VIRTUAL TABLE ... USING fts5` works |
| Verifier accuracy cards | 100% real (n=1), 99.38% bench (n=320): local *answers* only, not compression | dashboard |
| Fidelity benchmark for distillation | none exists; the harness measures the router only | `harness/README.md` |
| Config edits already made on 2026-10-21 | `.env`: `PLAN_CHATGPT=chatgpt-go`; `plans.ts`: `chatgpt-go` window 300 min; `providers.ts`: chatgpt window 300 min; `.env` budget comment marked unverified | pending owner accept |

---

## 3. Answers to the owner's questions

### 3.1 Tool search and Remote Control behind the gate

**Mechanism (Anthropic docs, verified).** With tool search on, Claude Code still sends every tool definition in `tools` on every request, but marks most of them `defer_loading: true` and includes a `tool_search_tool_*` entry. The API keeps deferred tools out of the context window and expands `tool_reference` blocks only when the model searches for a tool. Behind a non-Anthropic address, Claude Code stops setting `defer_loading`, so every schema enters the context. With about 150 MCP tools (slm-gate, Jam, Firecrawl, Chrome DevTools, Figma, Next devtools, Claude Docs) that is tens of thousands of tokens per request, cached after turn one but still carried and counted. Anthropic's own example: a five-server setup costs about 55k tokens; tool search cuts that by over 85%.

**Does the gate need to mimic it? No.** The gate forwards the body byte for byte ([forward.ts:184](../../src/llm-gate/forward.ts#L184)) and every non-hop-by-hop header, and the Anthropic format module only rewrites `tool_result` text. `defer_loading`, the search tool entry, and the `server_tool_use` / `tool_search_tool_result` blocks in history all pass through. So `ENABLE_TOOL_SEARCH=true` next to `ANTHROPIC_BASE_URL` restores the server-side behaviour with zero gate code.

**What to build anyway: measurement and a fallback switch.**

- *Measure (slice 1b).* For every Anthropic-format request record in ledger `meta`: `tools_count`, `tools_deferred`, `tools_tok_est` (sum of `JSON.stringify(tool).length / 4` over non-deferred tools). Dashboard card "Tool definitions in context per request". Done when the card shows deferred ≈ total minus 5 with tool search on, and a warning line when it is 0.
- *Fallback switch (slice 1c, only if 1b shows tool search is not working through the gate).* `LLM_GATE_DEFER_TOOLS=off|auto`. In `auto`, when a request has more than 20 tools and none is deferred, the gate sets `defer_loading: true` on every tool except an allowlist (`Bash, Read, Edit, Write, Grep, Glob, TodoWrite, Agent` and the names in `LLM_GATE_NON_DEFERRED_TOOLS`), prepends `{ "type": "tool_search_tool_bm25_20251119", "name": "tool_search_tool_bm25" }`, and moves any `cache_control` from a deferred tool to the last non-deferred one (a deferred tool with `cache_control` is a 400). The decision must be keyed per conversation like `distill.ts` `decisionKey`, so the tools array is identical every turn. Risk to state in the plan: if the client does not round-trip `server_tool_use` blocks, the next request fails; so `auto` must fail open to the original body on any upstream 400 and record it.

**Remote Control** is driving a local session from the claude.ai app. The owner does not use it. No loss.

### 3.2 Two models "in tandem", and the GPU question

Today the split is by role ([roles.ts](../../src/models/roles.ts)): gate model = classify, compress prose runs, tag risk; brain = extract and answer open decisions (with 3-sample self-consistency), answer first messages. Ollama keeps both resident. They can serve requests at the same time, but there is one GPU: the M4 Pro's 20 GPU cores run whichever model is generating, through Metal, and two concurrent generations time-share those cores and, more importantly, the memory bandwidth that bounds token speed. Cores cannot be pinned per model, and CPU cores (`num_thread`) do not matter when generation runs on the GPU. So "dedicate more cores" is not a lever. What is: keep both models resident (done), never load a third model (the embedding eviction), keep `NUM_CTX` at 8192 unless RAM is tight, and prefer sequential calls when latency-bound (`MAX_CONCURRENT_SEGMENT_CALLS` is 2; a benchmark at 1 vs 2 belongs in slice 9).

The tandem pattern that is missing is **cross-checking**: the gate compresses, the brain verifies that every requirement survived (section 3.4). That is a free quality gate and the heart of this brief.

### 3.3 Can the brain intercept every message, and the gate run on every message?

- **Gate model, every message: already yes.** Step B distillation runs on every forwarded request for new command, search and listing results over `DISTILL_MIN_TOKENS` ([distill.ts](../../src/llm-gate/distill.ts)). Cheap addition (slice 3c): classify each new user-typed turn with the gate model and store `category` in `meta`, so `ROUTING_TUNE` has data to learn from. Regex gates run first and cost nothing.
- **Brain, every message: yes where the context fits, which is rarely the whole turn.** Step A today only fires when the history has no assistant message ([anthropic.ts:165](../../src/llm-gate/formats/anthropic.ts#L165)). It can be widened to every user-typed turn (not tool-result turns) with the same eligibility rules, but the brain cannot see a 50k to 200k token history inside an 8,192-token window, and it cannot see the workspace. In the real ledger 3 of 8 first requests went local; the workspace-word filter blocks most coding turns by design (a wrong local answer costs more than a cloud call). Expect low yield from widening Step A.
- **Where the brain genuinely takes more load:** bounded-context local tools the cloud model calls instead of reading: `ask_elision` (section 4, slice 6), `find_existing` over a repo index (slice 8), decision memory in the resolver (slice 7), and the fidelity verifier (slice 5). Each gives the brain a few thousand tokens it can hold and a question it can answer, and each replaces a 2,000-token page or a file read on the cloud side.

### 3.4 Skill shrinkage: quality, accuracy, and how to measure and guard it

**Today** the cloud model gets the first and last 70 lines of a skill. It either expands the middle (two to three 2,000-token pages, each a full cloud turn) or works blind. About one in five conditionings in the last 30 days was not expanded, so those runs lacked the workflow steps.

**With `DISTILL_SKILLS=on`** headings, code fences, tables, blockquotes, frontmatter and every `configs/preserve/tls.json` line stay verbatim; prose runs of 400+ characters are cut to 35% of their words by the gate model with a prompt that says to keep every instruction, name, number and path. Numbered steps are prose to this code, so specifics inside them can drop. The 2025 empirical study on prompt compression found every method increased hallucination through information loss. There is no fidelity benchmark in the repo. So quality after shrinking is **unmeasured** today.

**Design to measure it and drive risk toward zero (slice 5, the core of this brief):**

1. *Deterministic invariants, checked by code, fail closed.* Extract from the original: every line matching a preserve pattern; every line containing `MUST`, `NEVER`, `ALWAYS`, `required`, `forbidden`, `only`; every `mcp__*` tool name; every file path; every number with a unit; every fenced block and table. After reassembly each must appear verbatim in the output. Any miss means the original is sent and `meta.fidelity_lost` lists what was lost. Protected blocks already have this check ([elision.ts:565](../../src/utils/elision.ts#L565)); extend it to requirement lines.
2. *Model-judged recall, brain checks gate.* Brain extracts a numbered list of requirements from the original prose run (JSON schema, `generateJSON`), then checks each against the compressed run and returns `kept: boolean[]`. Recall below `DISTILL_FIDELITY_MIN` (default 0.95) sends the original. Cost: one extra brain call per compressed run, only on cache misses (90 of 420 so far).
3. *Ledger and dashboard.* Per condition event write `meta.fidelity = { deterministic: 1|0, recall: 0.0..1.0, lost: [...], mode: 'truncate'|'summarize'|'verbatim' }`. New dashboard card "Skill fidelity" beside the accuracy card: average recall, deterministic pass rate, expansion rate (feedback per condition), and the three worst skills by recall. Done when the card renders from real rows.
4. *Offline fidelity bench, no API key.* `pnpm run fidelity`: for every distinct skill text in the `cache` and `elision_cache` tables (42 today) run `distillToolResult` with the real models, print the table from step 3, exit non-zero if any deterministic invariant fails or recall < threshold. Jest fixtures: three real skill files checked into `tests/fixtures/skills/` with the expected preserved lines, so CI catches a regression without Ollama by using the injected engine.
5. *Fail-safe wording.* The guard makes the failure mode "the original was sent" rather than "wrong text was sent". Deterministic classes reach 0% loss by construction. Model-summarised prose has a measured residual; the threshold is the dial, and the owner reads it on the dashboard.
6. *Authoring guard.* Skills can wrap their execution steps in `<!-- slm-gate:verbatim-start -->` ... `<!-- slm-gate:verbatim-end -->` (already recognised at [elision.ts:481](../../src/utils/elision.ts#L481)). The fidelity bench should report which skills lose the most so the toolbox authors add the markers.

### 3.5 Can SQLite give the local model the full skill while the cloud sees the short one?

It already does. `elision_cache` stores the full original with line ranges, and the resolver receives the full text ([pipeline.ts:207](../../src/mcp-gate/pipeline.ts#L207)). What is missing is a way for the cloud model to use that without paging. Slice 6 adds `ask_elision`: the cloud model asks a question with the elision id; the brain answers from the stored original, chunked by headings so each part fits `NUM_CTX`; answers are cached by id plus question in the `cache` table. Three hundred tokens back instead of two thousand.

### 3.6 Codex on ChatGPT Go, verified as far as public sources allow

- Codex is included with Go. OpenAI's help page confirms inclusion but publishes no per-window number for Go.
- Codex meters a rolling 5-hour window plus a weekly cap (restored for Plus on 2026-08-25). The ChatGPT chat UI's 3-hour message window does not apply to Codex traffic.
- Edits made: `chatgpt-go` window 300 min in `plans.ts`; chatgpt provider window 300 min in `providers.ts`; `.env` budget comment marked unverified with the measurement procedure. `CHATGPT_WINDOW_BUDGET=160` is still a Plus-derived guess. Measure: `/status` in Codex CLI at window start and after N messages; budget = N / (percent used / 100).
- Open design question for the loop: Codex's own meter is percentage-based on tokens internally, but OpenAI exposes it as "local messages". With `metering: 'message'` only `defer_local` events free minutes; distillation of Codex tool output will show tokens saved but 0 minutes. Option: a `codex` provider id with `metering: 'compute'` and a measured token budget. Record this as a decision for the owner, not a default.

### 3.7 Build our own, inspired by codebase-memory-mcp and Ponytail

Both are MIT licensed. codebase-memory-mcp is Go, so its code does not port; its concepts do. Ponytail is prompt text; its wording can be reused with attribution.

Take from **codebase-memory-mcp**: identifier-aware search (it splits camelCase and snake_case for FTS5; `better-sqlite3` cannot load a custom tokenizer, so store a pre-split `tokens` column), the tool contracts `search_code`, `get_architecture`, `detect_changes` (good names for ours), incremental indexing by file mtime, and its one-shot CLI mode as an optional evidence source for the resolver.

Take from **Ponytail**: the four-rung ladder (needed? already in codebase? platform or stdlib? installed dependency? then write the minimum), the `shortcut:` deferred-debt comment convention, and the measurement band idea. Install Ponytail itself in Claude Code and Codex directly; slm-gate never touches the system prompt (decoupling contract rule 3).

Our build (slice 8): a `repo_symbols` table plus FTS5 `repo_fts` in the ledger database, regex symbol extraction for TS/JS/Python/Go, refreshed by mtime on each MCP call, used by (a) the resolver's evidence step, (b) a `find_existing` tool, and (c) an appended "Existing code that may already cover this" section on conditioned skills, which is the local-model version of Ponytail's rung two. No embedding model. RAM cost is zero beyond the two loaded models; the index is on disk.

### 3.8 Model choice

No model in the 2 to 4 GB range beats Qwen3.5-4B on published text and code numbers (MMLU-Pro 79.1, LiveCodeBench v6 55.8, IFEval 89.8; Gemma 4 E4B 69.4 / 52.0 at 6.6 to 9.5 GB; Phi-4-mini MMLU-Pro 52.8). Brain stays. The gate model `qwen2.5-coder:3b` is a 2024 model; bench `qwen3.5:2b` (already pulled) in the gate role before switching (slice 9). `qwen3.5:9b` as brain fits 24 GB but leaves less room for the IDE; defer until the pipeline has traffic.

---

## 4. Work items, in order, with done-conditions

Each slice is independently shippable, lands behind its own setting where behaviour changes, and keeps the trunk releasable.

| # | Slice | Files | Setting | Done when |
|---|---|---|---|---|
| 1a | Wire Claude Code to the gate | `~/.claude/settings.json`: `{"env":{"ANTHROPIC_BASE_URL":"http://localhost:8787","ENABLE_TOOL_SEARCH":"true"}}` | none | `llm` rows with `meta.distill.candidates > 0`; deferred tools still load on demand |
| 1b | Measure tool definitions in context | `src/llm-gate/server.ts`, `src/dashboard/data.ts`, `index.html` | none | card shows deferred count per request; warning when 0 |
| 1c | Gate-side deferral fallback | `src/llm-gate/tools-defer.ts` (new), `server.ts` | `LLM_GATE_DEFER_TOOLS=off|auto` | only if 1b shows 0 deferred with tool search on; fails open on 400 |
| 2 | Wire Codex | `~/.codex/config.toml` per `docs/setup.md:285` | none | ChatGPT card appears on the dashboard |
| 3a | Distillation timeout watch | `.env` `DISTILL_BUDGET_MS` 3000 to 10000 if needed | existing | `meta.distill.timeouts` under 10% of candidates |
| 3b | Charge expansions against savings | `src/mcp-gate/server.ts:149` (move `writeEvent` after `page`, set `out_tok`), `src/ledger/index.ts:386` (`return -(e.out_tok \|\| 0)`) | none | daily totals drop; dashboard shows net |
| 3c | Per-turn classification for routing data | `src/llm-gate/server.ts` | existing `ROUTING_TUNE` | `meta.category` on every user-typed turn |
| 4 | Resolver cleanup | `src/resolver/index.ts` | none | 0 `format` errors over 50 runs (JSON schema already native; check prompt size vs `NUM_CTX`) |
| 5 | Model shrinking with fidelity guard, bench and card | `src/utils/elision.ts`, `src/models/reasoning.ts` (brain recall check), `src/ledger/index.ts` (`meta.fidelity`), `src/dashboard/*`, `scripts/fidelity.ts` (new), `tests/fixtures/skills/*` | `DISTILL_SKILLS=on`, `PROMPT_VERSION=v2`, `DISTILL_FIDELITY_MIN=0.95` | `pnpm run fidelity` passes on all 42 cached skills; expansions per conditioning < 0.3; card renders |
| 6 | `ask_elision` tool | `src/mcp-gate/server.ts` (tool list + handler), `src/utils/elision.ts` (`splitByHeadings`) | none | cloud model uses it; answers ≤ 300 tokens; cached by id + question |
| 7 | Decision memory for the resolver | `src/resolver/decisions.ts` (new), `.slm-gate/decisions/*.md` per repo (OKF-style frontmatter: `type`, `verified`, `stale_after`) | none | same question never asked twice in a repo; FTS5 match on question text, no embeddings |
| 8 | Repo index and `find_existing` | `src/index/repo-index.ts` (new), `src/mcp-gate/server.ts`, `src/resolver/index.ts` | `REPO_INDEX=on` | resolver questions name real files; "Existing code" section appears on conditioned skills |
| 9 | Gate-model bench and concurrency bench | `harness/`, `.env` `SLM_GATE_TESTING_MODEL=qwen3.5:2b`; `MAX_CONCURRENT_SEGMENT_CALLS` 1 vs 2 | none | table of latency and accuracy per model and per concurrency; owner picks |
| 10 | Install Ponytail in Claude Code and Codex | outside this repo | none | `/ponytail-gain` shows sessions |

Snippets for slices 3b, 5, 6 and 7 are in the chat transcript of 2026-10-21 and reproduced here in short form.

Slice 3b, `src/ledger/index.ts`:

```ts
if (e.route === 'feedback') return -(e.out_tok || 0);
```

Slice 5, brain recall check, `src/models/reasoning.ts`:

```ts
export async function checkFidelity(params: { slm: SLM; original: string; compressed: string }): Promise<{ recall: number; lost: string[] }> {
  const { slm, original, compressed } = params;
  const reqs = await slm.generateJSON(CONFIG.SLM_BRAIN_MODEL,
    `List every instruction, requirement, constraint, tool name, path and number in this text as short strings.\n\n${original}`,
    z.object({ requirements: z.array(z.string()).max(40) }), 0);
  const check = await slm.generateJSON(CONFIG.SLM_BRAIN_MODEL,
    `For each requirement, answer true only if the compressed text still states it.\n\nRequirements:\n${reqs.requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nCompressed text:\n${compressed}`,
    z.object({ kept: z.array(z.boolean()) }), 0);
  const lost = reqs.requirements.filter((_, i) => !check.kept[i]);
  return { recall: reqs.requirements.length ? 1 - lost.length / reqs.requirements.length : 1, lost };
}
```

Slice 6, tool registration, `src/mcp-gate/server.ts` next to `expand_elision`:

```ts
tools.push({
  name: 'ask_elision',
  description: 'Ask a question about elided text; a local model answers from the full original',
  inputSchema: { type: 'object', properties: { elisionId: { type: 'string' }, question: { type: 'string' } }, required: ['elisionId', 'question'] },
});
```

Slice 7, decision file format, `.slm-gate/decisions/architecture-direction.md`:

```markdown
---
type: Decision
title: Architecture direction
verified: [{ by: "human:bz3b", at: "2026-10-21" }]
stale_after: "2027-04-01"
---
API-first. Primary boundary is the MCP protocol and the four wire formats.
```

Slice 8, schema:

```sql
CREATE TABLE IF NOT EXISTS repo_symbols (path TEXT, line INTEGER, kind TEXT, name TEXT, signature TEXT, mtime INTEGER);
CREATE VIRTUAL TABLE IF NOT EXISTS repo_fts USING fts5(path, name, tokens, signature, body, tokenize='unicode61');
```

---

## 5. Options considered and rejected

- *Gate-side tool search as the default.* Rejected: the server-side feature already works through the gate; a gate rewrite of the tools array adds risk for no gain. Kept only as a measured fallback (1c).
- *Widening Step A to every turn as the main lever.* Rejected as primary: 8,192-token local context cannot hold a coding conversation; yield is low and a wrong local answer is costly. Kept as a small slice (3c) for routing data.
- *Embedding-based similarity (`nomic-embed-text`) for decisions, adaptive distillation or semantic cache.* Rejected: a third loaded model evicts a working model on this machine. FTS5 BM25 plus the brain model instead.
- *Running codebase-memory-mcp as a required dependency.* Rejected: Go binary, separate process, and slm-gate's `DOWNSTREAM_MCP` takes one server. Kept as an optional evidence source via its CLI.
- *Switching the brain to qwen3.5:9b now.* Deferred: no traffic yet to justify the RAM.
- *Changing `metering` for chatgpt to tokens.* Deferred to the owner: OpenAI exposes messages, not tokens.

---

## 6. Constraints the plan must respect

1. The owner reviews every diff and commits. Agents never stage, commit or push. One branch, one PR for the batch.
2. Never purge data: no deleting ledger rows, caches or elisions. Hand destructive commands to the owner.
3. Never pull or require `nomic-embed-text` or any third model. New features use FTS5 and the two loaded models.
4. The model gate never adds to the system prompt and never names a toolbox (`ARCHITECTURE.md`, decoupling contract).
5. All local-model JSON uses native structured outputs (`format: jsonSchema`), never markdown extraction.
6. Every local-model call has a token ceiling and a timeout.
7. Distillation decisions are byte-stable per conversation (prompt cache, Anthropic thinking validity).
8. Any change to distillation bumps `PROMPT_VERSION`, otherwise cached results fake both regressions and fixes.
9. Fidelity guards fail closed: on any doubt send the original.
10. macOS and Linux only. Node 22+, pnpm 10+. Tests with Jest; `pnpm run build` and `pnpm test` must stay green after every slice.
11. Pro/Max login through the gate is settled; do not reopen it.
12. Plain, succinct wording in docs and comments; questions to the owner are yes/no or pick-one.

---

## 7. Sources

- Anthropic tool search tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Claude Code LLM gateway: https://code.claude.com/docs/en/llm-gateway-connect
- ANTHROPIC_BASE_URL and ENABLE_TOOL_SEARCH: https://qcode.cc/en/anthropic-base-url-setup-guide
- Codex with ChatGPT plans: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- Codex 5-hour limit restored for Plus: https://www.techrepublic.com/article/news-openai-five-hour-codex-limit-chatgpt-plus/
- Ollama parallel requests: https://www.glukhov.org/llm-performance/ollama/how-ollama-handles-parallel-requests/
- Empirical study on prompt compression (2025): https://arxiv.org/pdf/2505.00019
- Qwen3.5-4B model card: https://huggingface.co/Qwen/Qwen3.5-4B
- Gemma 4 model card: https://ai.google.dev/gemma/docs/core/model_card_4
- Ollama libraries: https://ollama.com/library/qwen3.5 , https://ollama.com/library/gemma4 , https://ollama.com/library/granite4
- codebase-memory-mcp (MIT): https://github.com/DeusData/codebase-memory-mcp
- OKF spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
- Ponytail (MIT): https://github.com/DietrichGebert/ponytail
