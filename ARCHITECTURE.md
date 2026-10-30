# Architecture

`small-language-model-gate` (CLI: `slm-gate`) is a decoupled local-SLM pre-processing layer that sits in front of a cloud LLM and works inside any MCP client. It shrinks what reaches the cloud model and never answers a request itself.

```text
Architecture Direction: API-first
Primary Product Boundary: API — the MCP protocol (mcp-gate) and four model wire formats (llm-gate)
Primary Business Logic Boundary: the two pipelines, src/mcp-gate and src/llm-gate (with src/setup keeping the model gate running)
Primary API Consumers: coding tools (Claude Code, Codex, Gemini CLI, Cline and others) and their MCP clients
Source of Truth for Workflows: the coding tools; slm-gate never changes what they ask for, only how much is sent
Rationale: there is no UI of its own; the CLI is for setup and diagnosis, and the built-in dashboard (src/dashboard, read-only over the ledger) and the optional Langfuse mirror only report
```

## Core Components

### Distillation Fidelity
`slm-gate` compresses large tool outputs to save cloud tokens, under layered fidelity controls (`src/utils/elision.ts`, `src/utils/preserve-patterns.ts`, `src/models/reasoning.ts`):
1. **Protected by code, never shown to a model**: fenced code, tables, headings, frontmatter, rule lines (`MUST`/`SHALL`), tool names, paths, URLs and numbers with units, plus the patterns in `DISTILL_PRESERVE_PATH` (`extend` or `replace` the built-ins). Only plain prose runs reach the gate model.
2. **Deterministic rules by tool name** before any model call: a file keeps its outline and the lines about the task, a log its errors and last 50 lines, a search its first 50 lines. File reads are never distilled.
3. **The fidelity guard** (`DISTILL_SKILLS=on`): each shortened prose run of a skill is checked by the brain model against the requirement sentences the code listed from the original and kept only at recall ≥ `DISTILL_FIDELITY_MIN`; a failed run goes out verbatim, and the missing sentence is stored in the ledger (`distill_protect`) and protected by code on every later run.
4. **Adaptive feedback** (`DISTILL_ADAPTIVE=on`, off by default): lines the agent had to `expand_elision` are embedded with `EMBED_MODEL`, and lines that mean the same are left alone next time.


The system consists of two independently-runnable middleware layers plus one shared ledger:

1. **Layer 1: `mcp-gate`**
   - A standard MCP proxy (supports stdio and HTTP transports).
   - A client connects to it, and it optionally forwards to a downstream MCP server.
   - It intercepts skill/prompt payloads and runs a local small model (SLM) to compress, ground, and disambiguate them before they reach the client's editor model.
   - A toolbox's result comes back whole: pictures and other blocks, the error flag (`isError`), structured data (`structuredContent`) and any other field pass through unchanged. Only the text is conditioned, once per call: all text blocks joined in order, placed where the first text block was (so a later text block moves ahead of a picture that preceded it, and only the first text block's annotations are kept).

2. **Layer 2: `llm-gate` (the model gate)**
   - One local HTTP server (`LLM_GATE_PORT`, default 8787) speaking four wire formats, with no translation between them: Anthropic Messages (`/v1/messages`), Chat Completions (`/v1/chat/completions`), Responses (`/v1/responses`) and Gemini (`/v1beta/models/{model}:generateContent|streamGenerateContent`). Each format lives in `src/llm-gate/formats/`; behaviour is keyed on the wire format, never on which coding tool sent it.
   - A coding tool points its model address at it. Each request goes back to the provider its format belongs to, with the tool's own login (every header except hop-by-hop ones is forwarded; streams are piped byte for byte with no total timeout).
   - The gate never answers a request itself. It only shrinks what a request carries: only the text of large command, search and listing tool results in the newest turn changes; the system prompt, tool list, anything the person typed, ids, thinking, signatures, images and `cache_control` never do. Each result is distilled once and the stored text is resent every later turn (`llm_distilled`), so the provider's prompt cache keeps hitting and earlier thinking stays valid. A result that fails or runs past `DISTILL_BUDGET_MS` is sent as it was.
   - **Conversation memory** (`CONVERSATION_MEMORY`, on by default): after each reply the turn is noted, and while the gate has no request in flight the brain model folds it into a short summary per conversation (goal, decisions, files in play), stored in the ledger. The MCP gate's `ask_elision` and the resolver read that summary beside the message they answer; a missing, stale, failed or wrong-version summary means today's one-message behaviour. The summary text never leaves the machine and is never written into an event row.
   - Route values in the ledger: `forward_compressed` (distilled), `forward_raw` (unchanged), `memory_fold` (one fold). `defer_local` rows exist only in ledgers written before 1.4, when the gate could answer a first request itself; they stay readable and are priced as they were.

3. **Ledger** (`src/ledger/`, one SQLite file named by `LEDGER_PATH`)
   - Every request from either layer writes one row locally; the same file keeps the stores the gates read back. `src/ledger/index.ts` is a barrel over these modules, so callers import from `src/ledger/index.js`:
     - `db.ts`: opens the file once per process (`getDb()`), creates the schema, runs the additive column migrations and the start-up retention sweep.
     - `events.ts`: the one row per request (`writeEvent`) and the maths read off those rows: routing outcome, provider attribution, tokens and window minutes saved. Read by `slm-gate metrics`, the dashboard and `ledger:sync`.
     - `elisions.ts`: the original text of every result the MCP gate cut, for `expand_elision` and `ask_elision`; size-capped by last use and expired by age.
     - `protections.ts`: the sentences the fidelity guard once found missing; a line that contains one is kept verbatim from then on. The dashboard counts them.
     - `cache-deps.ts`: the conditioning cache (saved results) and the repository state each entry relied on, so a hit is served only while nothing it depended on changed.
     - `decisions.ts`: the decision-memory index over each repository's `.slm-gate/decisions` files, read by the open-decisions step.
     - `memory.ts`: one running conversation summary per conversation, written by the model gate's fold and read by `ask_elision` and the resolver (`matchMemory` fails closed).
     - `repo-index.ts`: the repository symbol index (`REPO_INDEX=on`), filled by `src/index/repo-index.ts` and read by `find_existing` and the resolver.
     - `distill.ts`: the model gate's shrink decisions (one per result, resent every turn), the distillation feedback rows and the tool-pattern fidelity policy both gates consult.
   - The optional Langfuse mirror lives beside it in `src/langfuse/`: `format.ts` turns one row into the trace, generations and scores (pure), and `sink.ts` queues that payload in the same SQLite file at write time and ships it every 15 s (both gates flush; repeatedly rejected rows are parked in a dead-letter table). `src/ledger/sync.ts` sends the history by hand.

   ![The ledger folder after the split: the MCP gate writes rows and its own stores (elisions, cache-deps, protections) and reads decisions and the symbol index; the model gate writes rows, shrink decisions and the conversation memory; metrics, the dashboard and ledger:sync read the rows; each new row is formatted and queued for Langfuse and shipped every 15 s](docs/diagrams/ledger-modules.png)

   Explore it: [ledger-modules.html](docs/diagrams/ledger-modules.html) (open in a browser; nodes expand, paths can be traced).

## Native Structured Outputs Requirement

**CRITICAL:** All deterministic routing, reasoning, and JSON extraction must use Native Structured Outputs (`format: jsonSchema` for Ollama and `response_format: { type: "json_schema" }` for OpenAI compatible APIs). 
Do **NOT** use prompt engineering to request JSON wrapped in markdown blocks, and do not use regex to extract JSON. Relying on markdown extraction causes severe rambling and timeouts (specifically on Apple Silicon / `llama.cpp`) due to models failing to emit stop tokens or closing braces.


## Credentials and Billing

Neither layer holds a cloud credential of its own. The model gate forwards the coding tool's own login (subscription or API key) unchanged, so every forwarded request is billed exactly as it would be without `slm-gate`. The `CLOUD_*` settings are separate and optional: the resolver's cloud tier reads all of them; `SLM_PROVIDER=openai` reads `CLOUD_API_KEY` and sends the local-model calls to `OLLAMA_HOST`, not `CLOUD_BASE_URL`.

## How the Model Gate Stays Running

Coding tools start `slm-gate`'s MCP server themselves; nothing starts the model gate unless something does it for them. So the MCP server does (`src/setup/`):

- **At start-up** (at most ~1.5 s before the MCP handshake): probes `GET /slm-gate/health` on the gate's port. Nothing listening → launches the gate as a detached background process (log: `output/llm-gate.log`). Another program on the port, or an older build still running → a notice. In parallel it checks that Ollama runs and every model the settings name is pulled. It never starts Ollama or downloads anything.
- **After 15 s, then every minute:** the same probe and model check; a dead gate is relaunched. A problem is reported only when the second check still finds it.
- **Several MCP servers at once** (one per IDE window / CLI session) agree through marker files in `output/`: one launch per minute (`.gate-launch.<minute>`, created atomically), one desktop notification per problem per 10 minutes (`.notices/`), and `.gate-stopped` from `slm-gate stop`, which holds until `slm-gate start`/`restart` or a reboot. It records the ID the OS gives this boot (macOS `kern.bootsessionuuid`, Linux `boot_id`), so a clock change cannot end a stop; if that ID cannot be read at some moment, the stop is kept until the next successful read (even just after a reboot). Elsewhere it records the boot minute computed from the clock.
- **Problems** go to stderr, to a desktop notification, and (at start-up) into the MCP server's instructions, asking the AI to pass them to the user word for word.
- **Settings:** the gate is launched with every variable `src/config.ts` reads removed from its environment, so the one shared gate takes its settings only from `slm-gate`'s `.env`, never from the MCP `env` block of whichever tool started it first.
- The gate's health answer carries its pid, port, entry file and that file's modification time at start-up; a mismatch with the installed file marks the running gate as an older build.

## Only Programs on This Computer

Both HTTP servers (the model gate, and the MCP server when `MCP_GATE_TRANSPORT=http`) apply one rule, `src/utils/local-only.ts`:

- **Bind:** 127.0.0.1 and ::1 only (two servers, one handler), so other machines can't connect and `localhost` works whichever address a client tries first. If 127.0.0.1 is taken, or ::1 is held by another program, the server doesn't start (a half-bound gate would let `localhost` clients reach the other program).
- **Host:** must be `localhost`, `127.0.0.1` or `::1` (any port). Stops DNS rebinding, where a web page reaches 127.0.0.1 under its own domain name. Other spellings are refused (fail closed).
- **Origin:** absent (programs), or a page served from one of those names. Stops cross-site requests from any web page open in the browser.
- Refused requests get 403 and are neither forwarded nor recorded. `slm-gate doctor`'s port check makes the same binds, since a plain `listen(port)` succeeds next to a loopback-only server on macOS.

## Decoupling Contract

1. **Zero build-time dependency on `tech-lead-stack` (TLS).** All TLS knowledge resides exclusively in `src/adapters/tech-lead-stack.ts`, gated by `TLS_ADAPTER=on` + `DOWNSTREAM_MCP`, imported only via guarded dynamic import. Deleting this file leaves everything else compiling and passing tests.
2. **Each layer runs independently.** `llm-gate` operates without MCP (the MCP server only starts it; `slm-gate start` or `serve` do the same); `mcp-gate` operates without a cloud endpoint and can act as a standalone tool provider.
3. **The model gate names no toolbox.** Nothing under `src/llm-gate` mentions a downstream MCP toolbox, and the gate adds nothing to the model's instructions: the system prompt goes out as the client sent it. Toolboxes stay plug-and-play behind the MCP layer.
4. **Single source of configuration truth.** All configurations are located in `src/config.ts`.
5. **Provider-agnostic.** The model gate works with whatever provider each coding tool already uses, keyed only on wire format; the local model supports any Ollama tag.
