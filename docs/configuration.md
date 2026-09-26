# Configuration Setup Guide

`slm-gate` is configured through a `.env` file — a plain text file in the root of the repository that holds your settings. Think of it as a control panel with clearly labelled switches.

## Quick Start: Copy Your RAM Preset

Instead of starting from scratch, find your machine's RAM in the table below and copy the matching preset file for your editor. These are fully commented templates with sensible defaults already filled in.

> **Using 16 GB RAM?** That's the baseline configuration used throughout this guide. Copy the preset for your editor and you're most of the way there.

### All Configuration Preset Files

| Editor / Client | 16 GB RAM | 24 GB RAM | 32 GB RAM |
| :--- | :--- | :--- | :--- |
| **Google Antigravity** | [`.env.16gb.example`](../configs/antigravity/.env.16gb.example) | [`.env.24gb.example`](../configs/antigravity/.env.24gb.example) | [`.env.32gb.example`](../configs/antigravity/.env.32gb.example) |
| **Claude Code** | [`.env.16gb.example`](../configs/claude-code/.env.16gb.example) | [`.env.24gb.example`](../configs/claude-code/.env.24gb.example) | [`.env.32gb.example`](../configs/claude-code/.env.32gb.example) |
| **Claude Desktop** | [`.env.16gb.example`](../configs/claude-desktop/.env.16gb.example) | [`.env.24gb.example`](../configs/claude-desktop/.env.24gb.example) | [`.env.32gb.example`](../configs/claude-desktop/.env.32gb.example) |
| **Cursor** | [`.env.16gb.example`](../configs/cursor/.env.16gb.example) | [`.env.24gb.example`](../configs/cursor/.env.24gb.example) | [`.env.32gb.example`](../configs/cursor/.env.32gb.example) |
| **Cline / Continue** | [`.env.16gb.example`](../configs/cline-continue-opencode/.env.16gb.example) | [`.env.24gb.example`](../configs/cline-continue-opencode/.env.24gb.example) | [`.env.32gb.example`](../configs/cline-continue-opencode/.env.32gb.example) |
| **Generic Stdio** | [`.env.16gb.example`](../configs/generic-stdio/.env.16gb.example) | [`.env.24gb.example`](../configs/generic-stdio/.env.24gb.example) | [`.env.32gb.example`](../configs/generic-stdio/.env.32gb.example) |
| **Generic HTTP** | [`.env.16gb.example`](../configs/generic-http/.env.16gb.example) | [`.env.24gb.example`](../configs/generic-http/.env.24gb.example) | [`.env.32gb.example`](../configs/generic-http/.env.32gb.example) |
| **Full Reference** | [`.env.example`](../.env.example) (all variables, fully documented) | | |

Each preset holds every setting from `.env.example`, with the models and sizes for that amount of RAM. Copy the one for your tool and RAM to `.env` in the `slm-gate` folder.

> **Note for Antigravity users:** values in the `"env"` block of `~/.gemini/config/mcp_config.json` apply to `slm-gate`'s MCP server inside Antigravity and override `.env` there. The model gate reads only `slm-gate`'s `.env`, so keep the model settings the same in both places.

## The 16 GB Baseline Configuration

Here is a minimal, working `.env` for a 16 GB machine. Copy this to a file named `.env` in your repository root and fill in the blanks:

```bash
# ── Local AI Models ────────────────────────────────────────────────────────
SLM_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_KEEP_ALIVE=12h
SLM_BRAIN_MODEL=qwen2.5-coder:3b        # The smarter local model (heavier tasks)
SLM_GATE_MODEL=qwen2.5-coder:0.5b      # The tiny router model (instant decisions)
NUM_CTX=4096                             # Context window — keep at 4096 for 16 GB
TEMPERATURE=0

# ── Verifier ───────────────────────────────────────────────────────────────
STRICTNESS_LEVELS=0,1,2,3,4,5
HEADLINE_STRICTNESS=4

# ── API model (optional: benchmark and resolver cloud tier only) ──────────
CLOUD_API_STYLE=anthropic               # or: openai
CLOUD_BASE_URL=
CLOUD_API_KEY=                          # Leave blank unless you run `slm-gate bench`
CLOUD_MODEL=

# ── Servers ────────────────────────────────────────────────────────────────
LLM_GATE_PORT=8787
LLM_GATE_AUTOSTART=on                   # The MCP server starts the model gate for you
MCP_GATE_TRANSPORT=stdio
DOWNSTREAM_MCP=                         # Leave blank for standalone; set to TLS config for downstream

# ── Ledger & Telemetry ─────────────────────────────────────────────────────
LEDGER_PATH=/Users/yourname/projects/small-language-model-gate/output/ledger.sqlite   # Full path on YOUR machine — see the section below
LANGFUSE_PUBLIC_KEY=                    # Optional — leave blank if not using Langfuse
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=https://cloud.langfuse.com

# ── Subscription Plan (for quota metrics display) ─────────────────────────
SUBSCRIPTION_PLAN=claude-pro            # Set this to match your actual plan

# ── ⚠️ Window Budgets (REQUIRED for the Cycle cards — set all three) ──
# Estimates within a margin of error: providers don't publish these. See the reference below.
CLAUDE_WINDOW_BUDGET=460000             # tokens per 5-hour window (Claude Pro, estimate)
CHATGPT_WINDOW_BUDGET=160               # messages per 3-hour window (ChatGPT Plus, estimate)
GEMINI_WINDOW_BUDGET=500000             # tokens per 5-hour window (Gemini AI Pro, estimate)

# ── RAM Preset ────────────────────────────────────────────────────────────
RAM_PRESET=ram-16
TLS_ADAPTER=off                         # Set to 'on' only if using Tech-Lead-Stack downstream
```

---

## Ledger Path Must Be a Full Path on Your Machine

`LEDGER_PATH` is where `slm-gate` writes its local SQLite ledger. It must be the **full path on your machine**, starting from the root of your disk — never a path relative to the repository.

```bash
# macOS / Linux
LEDGER_PATH=/Users/yourname/projects/small-language-model-gate/output/ledger.sqlite

# Windows
LEDGER_PATH=C:\Users\yourname\projects\small-language-model-gate\output\ledger.sqlite
```

To get the value for your machine, run `pwd` inside the repository folder and append `/output/ledger.sqlite`.

**Why this matters.** Your editor or MCP host launches `slm-gate` as a background process, and the folder it launches *from* is not your repository. Claude Desktop, for example, starts MCP servers from a working directory that does not exist at all. A relative value such as `./output/ledger.sqlite` is resolved against that folder, so the server fails on startup with:

```text
Error: ENOENT: no such file or directory, mkdir './output'
```

The same relative path works from a terminal inside the repository, which is why it can look fine in one place and fail in the app.

Two rules follow from this:

- **Leaving `LEDGER_PATH` blank is safe.** A blank value means "use the default", which is `output/ledger.sqlite` under the folder where you installed `slm-gate`, already resolved to a full path.
- **If you set it, set the full path.** `pnpm run dev doctor` reports an issue for any value that is not a full path.

If you also run CLI commands such as `pnpm run slm-gate metrics` from a terminal, both the MCP server and the CLI read this same `.env`, so they land on the same file. If your host's config `env` block sets `LEDGER_PATH` directly, use the same full path there.

---

## Configuration Setting Reference

Every setting `slm-gate` reads is explained below in plain English. Settings are grouped in the order they matter most during setup.

### Local Model (SLM) Settings

- **`SLM_PROVIDER`** — Where your local AI comes from. `ollama` runs it on your machine for free (the normal choice). `openai` redirects it to a cheap hosted model instead — useful if your machine can't run a local AI.
- **`OLLAMA_HOST`** — The address where Ollama is listening. Only change this if you're running Ollama on a different machine or port. Must be a full URL including `http://`. Default: `http://localhost:11434`
  - Note: Ollama's **own** `OLLAMA_HOST` variable, the one its docs and `ollama serve` use, is a bare `host:port` such as `127.0.0.1:11434`. `slm-gate` reads the same variable name but needs the scheme in front. If you have Ollama's form exported in your shell, set `slm-gate`'s value explicitly in its `.env` so the exported one doesn't reach it.
- **`OLLAMA_KEEP_ALIVE`** — How long a loaded model stays in memory after use. Keeping it loaded means instant responses next time; lowering it frees memory. Default: `12h`
- **`SLM_BRAIN_MODEL`** — The name of your smarter local model, used for compression, summarisation, and local resolution of harder tasks.
- **`SLM_GATE_MODEL`** — The name of your tiny, fast local model, used only for routing decisions ("can I handle this locally?"). Speed is the priority here.
- **`SLM_GATE_TESTING_MODEL`** — Only used when running the benchmarking harness. Ignore for everyday use.
- **`NUM_CTX`** — The maximum amount of text the local model can consider in a single request, measured in tokens (roughly ¾ of a word per token). Larger values allow the model to consider more context at once, but use significantly more memory. Default: `8192` — reduce to `4096` for 16 GB machines.
- **`TEMPERATURE`** — How creative or random the local model's responses are. `0` means fully deterministic (always the same answer for the same input). Keep this at `0` — this tool needs consistent, repeatable decisions. Default: `0`
- **`SLM_TIMEOUT_MS`** — How long to wait for the local model to respond before giving up and escalating to the cloud. Increase if you have a slow machine. Default: `120000` (2 minutes)
- **`SELF_CONSISTENCY_K`** — When double-checking a local answer, how many times to silently re-ask the question. If all answers agree, the result is trusted. If they disagree, the request escalates to the cloud. Default: `3`
- **`SELF_CONSISTENCY_TEMP`** — The randomness used during those re-checks. A small amount of randomness is intentional — if the model gives the same answer even when nudged to vary, that's a strong signal it's correct. Default: `0.7`

### Verifier Strictness

After the local AI answers, a "verifier" grades whether the answer is good enough to trust. These control how strict that grading is.

- **`STRICTNESS_LEVELS`** — The available grading levels, from `0` (very lenient) to `5` (extremely strict). Leave this as-is. Default: `0,1,2,3,4,5`
- **`HEADLINE_STRICTNESS`** — The grading level actually in use. Higher means more local answers get escalated to the cloud (safer, higher quality, but costs more quota). Lower means more trust in local answers (saves more, but higher risk of lower quality). Default: `4`

### API Model (Optional) & Semantic Cache

The model gate doesn't use the `CLOUD_*` settings: it sends each request on with your coding tool's own login. They are read only by the benchmark (`slm-gate bench`), the resolver's cloud tier (`RESOLVER_CLOUD_TIER`) and `SLM_PROVIDER=openai`.

- **`CLOUD_API_STYLE`** — Which API format that provider uses: `openai` or `anthropic`.
- **`CLOUD_BASE_URL`** — The address of that provider's API.
- **`CLOUD_API_KEY`** — The API key for it. Leave blank unless you use one of the three features above.
- **`CLOUD_MODEL`** — The exact model name.
- **`SEMCACHE`** — Turns on "answer reuse." When enabled, identical read-only questions are answered from memory instead of making a new cloud call. Off by default. (`on` / `off`)
- **`SEMCACHE_THRESHOLD`** — How similar two questions must be before the old answer is reused. `0.95` is very strict. Default: `0.95`
- **`EMBED_MODEL`** — The local model used to measure question similarity. Default: `nomic-embed-text`

### Server Ports & Downstream MCP

- **`LLM_GATE_PORT`** — The port the model gate (`llm-gate`) listens on. Only change it if another program uses this port; then run `slm-gate restart`, and `slm-gate doctor` to get the new line for each coding tool. Set it only in `slm-gate`'s `.env`: a value in a tool's MCP `env` block or your shell is ignored when finding and starting the model gate. Default: `8787`
- **`LLM_GATE_AUTOSTART`** — When a coding tool starts `slm-gate`'s MCP server, also start the model gate in the background if it isn't running, and bring it back within a minute if it stops. `off` means you start it yourself with `slm-gate start`. Default: `on`
- **`LLM_GATE_DISTILL`** — Shrink large command, search and listing output before a request leaves your machine. `off` makes the gate pass requests on unchanged. Default: `on`
- **`LLM_GATE_LOCAL_FIRST`** — Let the local model try the first message of each conversation (never slash commands, never coding tasks that need the tool's own tools). Default: `on`
- **`LOCAL_ATTEMPT_BUDGET_MS`** — How long that first message may wait for a local answer before it goes on to your provider. Default: `6000`
- **`UPSTREAM_ANTHROPIC_URL`**, **`UPSTREAM_OPENAI_URL`**, **`UPSTREAM_CHATGPT_URL`**, **`UPSTREAM_GEMINI_URL`** (optional) — Where the model gate sends each kind of request.

  You don't need to fill any of these, whether you use a subscription or an API key. Leave all four blank. The gate already knows where each request goes and uses the correct address automatically.

  The only reason to set one: your company makes all AI traffic go through its own proxy server. Then you would put that proxy's address in the matching line. Everyone else leaves them blank.

  These four are split by provider, not by subscription vs API. Here is which one each login uses:

  | Setting | Subscription login | API key | Default address |
  |---|---|---|---|
  | `UPSTREAM_ANTHROPIC_URL` | Claude Pro/Max in Claude Code | Anthropic API key (Claude Code, Cline and others) | `https://api.anthropic.com` |
  | `UPSTREAM_OPENAI_URL` | — | OpenAI API key (Codex, Cline and others) | `https://api.openai.com/v1` |
  | `UPSTREAM_CHATGPT_URL` | ChatGPT login in Codex | — | `https://chatgpt.com/backend-api/codex` |
  | `UPSTREAM_GEMINI_URL` | — (a Google-account login can't go through the gate) | Gemini API key (Gemini CLI, `agy`) | `https://generativelanguage.googleapis.com` |

  Your coding tool's own login (subscription or API key) is sent either way.
- **`DOWNSTREAM_MCP`** — If you want `mcp-gate` to sit in front of another MCP server (like Tech-Lead-Stack), put that server's launch command here as a JSON string. Ships blank, which is standalone mode; any file path inside the JSON must also be a full path on your machine.
- **`MCP_GATE_TRANSPORT`** — How `mcp-gate` communicates with your editor: `stdio` (your editor launches it directly) or `http` (network connection). Most setups use `stdio`. Default: `stdio`
- **`MCP_GATE_PORT`** — The port for HTTP mode only. Default: `8788`

### Ledger & Telemetry

- **`LEDGER_PATH`** — Where the local database file is stored. This is what `pnpm run slm-gate metrics` reads from. Blank = `output/ledger.sqlite` under the install folder (already a full path). If you set it, it **must be a full path on your machine**, never one relative to the repository — see [Ledger Path Must Be a Full Path on Your Machine](#ledger-path-must-be-a-full-path-on-your-machine). `doctor` reports an issue for a relative value.
- **`PROVIDER`** — The cloud provider your IDE sends traffic to (`gemini`, `claude`, or `chatgpt`). Used for per-provider cycle extension metrics when the inbound request carries no recognizable model string. Not the same as `SLM_PROVIDER`. Default: `gemini`.
- **`LANGFUSE_PUBLIC_KEY`**, **`LANGFUSE_SECRET_KEY`**, **`LANGFUSE_HOST`** — Optional Langfuse connection. Fill these in only if you're using Langfuse for visual dashboards. Leave blank otherwise.
- **`SUBSCRIPTION_PLAN`** — Tells the metrics dashboard which plan you're on, so it can calculate how much subscription runway you've reclaimed. Valid values: `claude-pro`, `claude-max-5x`, `claude-max-20x`, `chatgpt-go`, `chatgpt-plus`, `chatgpt-pro-5x`, `chatgpt-pro-20x`, `gemini-plus`, `gemini-pro`, `gemini-ultra`. It sets the window *length* only, not the budgets below.
- **`CLAUDE_WINDOW_BUDGET`**, **`CHATGPT_WINDOW_BUDGET`**, **`GEMINI_WINDOW_BUDGET`** — ⚠️ **Required for the per-provider "Cycle" dashboard cards** (each provider has two: *Est. Seconds Saved (per prompt)* and *Est. Minutes Saved (total)*). How much your plan allows per usage window: *tokens* for Claude and Gemini, *messages* for ChatGPT. Set all three, whichever provider you use. If one is blank, both of that provider's cards stay empty. **These values, and the minutes they produce, are estimates within a margin of error:** Anthropic, OpenAI and Google don't publish them, only multipliers such as "Max 5x = 5× Pro".

  | Provider | Unit | Estimates by plan | Where the number comes from |
  |---|---|---|---|
  | Claude | tokens / 5 h | Pro ~460,000 · Max 5x ~2,300,000 · Max 20x ~9,200,000 | Max 5x measured 2026-09-16 (tokens sent ÷ `/usage` session share); Pro and 20x scaled by Anthropic's multipliers |
  | ChatGPT | messages / 3 h | Plus ~160 | Third-party reports, 2026 |
  | Gemini | tokens / 5 h | AI Pro ~500,000 · Ultra ~10,000,000 | Best guess: AI Pro assumed close to Claude Pro; Ultra is 20× AI Pro per Google |

  For a better number for your own account, divide the tokens you sent in a window by the share of the window used (Claude Code shows it in `/usage`). For Claude and Gemini, every token saved counts, including tool results shrunk by the MCP server. ChatGPT caps messages, so its window is only extended by prompts answered fully by the local model (`llm-gate`). Restart the gate after changing these. `slm-gate doctor` lists any that are missing.

### Context Trimming & Safe Recovery

When a tool response is very large, `slm-gate` compresses it and keeps only the essential parts. The original is stashed locally so the AI can retrieve any trimmed content cheaply on demand.

- **`DISTILL_MIN_TOKENS`** — Responses smaller than this (in tokens) are passed through untouched — they're too small to be worth compressing. **500 tokens ≈ ~50 lines of code.** Default: `500`
- **`DISTILL_BUDGET_MS`** — How long the model gate may hold one request while it shrinks that request's new tool output. Past it, the output is sent as it was (and stays that way for the rest of the conversation). Default: `3000`
- **`DISTILL_MAX_TOKENS`** — The maximum size a response can be after compression. Anything still over this limit after compression gets trimmed, and a retrieval marker is inserted so the AI can ask for the trimmed content. It is also the threshold at which the local model is asked to summarise at all, which in standalone mode is the only compression trigger there is. **2000 tokens ≈ ~200 lines of code.** Default: `2000`
- **`DISTILL_PRESERVE_PATH`** — Path to a file listing text patterns that must never be compressed or altered (e.g., specific code markers). Optional.
- **`DISTILL_PRESERVE_MODE`** — Whether your custom patterns are added to (`extend`) or replace (`replace`) the built-in protection list. Use `extend`. Default: `extend`
- **`KEEP_RECENT_TOOL_TURNS`** — How many of the most recent tool responses to always keep in full (never compress), because they're almost certainly still needed. Default: `2`
- **`ELISION_MAX_ENTRIES`** — Maximum number of original (pre-compression) responses stored in the local recovery cache. Default: `5000`
- **`ELISION_RETENTION_DAYS`** — How long a stored original is kept before automatic cleanup. Default: `180` days
- **`ELISION_MAX_MB`** — Total disk space budget for the recovery cache. When exceeded, the oldest entries are deleted first. Default: `500 MB`

### Advanced: Routing Tuner & Misc

- **`ROUTING_TUNE`** — When `on`, the gate learns from past results which types of requests the local model handles well, and routes those directly to cloud for request types where it usually fails. (`on` / `off`)
- **`ROUTING_TUNE_WINDOW`** — How many recent requests (per type) to consider. Default: `20`
- **`ROUTING_TUNE_MIN_SAMPLES`** — Minimum sample count before the tuner acts on a category's success rate. Default: `8`
- **`ROUTING_TUNE_THRESHOLD`** — Success rate below which the gate stops trying local for that request type. Default: `0.5`
- **`ROUTING_TUNE_EXPLORE_RATE`** — How often to try local even for categories it's learned to skip — keeps it adapting to improvement. Default: `0.15`
- **`RESOLVER_CLOUD_TIER`** — When `on`, allows the local AI to make a small, budgeted cloud call when it hits a genuinely ambiguous decision. (`on` / `off`)
- **`RESOLVER_CLOUD_BUDGET_USD`** — Hard dollar cap on the above feature. Default: `0` (off until you set a budget)
- **`RAM_PRESET`** — A convenience toggle that auto-selects sensible model defaults based on your RAM: `ram-8`, `ram-16`, `ram-32`, or `custom`.
- **`TLS_ADAPTER`** — Enables special handling for Tech-Lead-Stack payloads. Set to `on` only if TLS is your downstream. (`on` / `off`)

---

[README](../README.md) · [All docs](README.md) · Next: [Verification & Day-to-Day Use](daily-use.md)
