# The Two Setups

`slm-gate` runs in one of two setups. Both use the same pair of local models and the same settings file; they
differ in how much work the local models take on. Every other setting is documented in
[Configuration](configuration.md) and can be changed freely in either setup.

| | **Setup A: local models do more** | **Setup B: plain shrinking** |
| :--- | :--- | :--- |
| Skills (your toolbox's instructions) | shortened by the gate model under a guard that fails closed | sent word for word, cut at the ends with a marker when too long |
| Open questions in a skill | answered from a decision you wrote once, from the code the question names, then from files | answered from files and common practice |
| Tools the gate adds | `expand_elision`, `ask_elision`, `find_existing` | `expand_elision`, `ask_elision` |
| What the local steps know of the conversation | a running summary, folded by the brain model off the request path | nothing: one message at a time |
| Extra local-model work per skill | up to 8 short paragraph checks by the brain model, inside 60 s | none |
| What it costs you | a few seconds more on a skill's first conditioning; cached after | nothing extra |
| Choose it when | you want the savings the local models can give and the dashboard's fidelity card to tell you what they cost | you want the behaviour of earlier versions, or your toolbox's skills must never be reworded |

Switching between them is three lines in `.env` and `slm-gate restart`. Nothing else changes, and nothing in the
ledger is lost.

## Setup A: local models do more

| Key | Value | Note |
| :--- | :--- | :--- |
| `SLM_BRAIN_MODEL` | `qwen3.5:4b` | the pair: answers, checks, decides |
| `SLM_GATE_MODEL` | `qwen3.5:2b` | the pair: sorts, shortens, rates risk |
| `SLM_PIN_MODELS` | `on` | keeps the pair loaded; evicts a third model that displaced one of them |
| `NUM_CTX` | `8192` | must match the Ollama launch file (`OLLAMA_CONTEXT_LENGTH`) |
| `OLLAMA_KEEP_ALIVE` | `12h` | must match the Ollama launch file (`OLLAMA_KEEP_ALIVE`) |
| `LLM_GATE_DISTILL` | `on` | shrink large tool output in model requests |
| `DISTILL_SKILLS` | `on` | skill shrinking under the fidelity guard |
| `REPO_INDEX` | `on` | the `find_existing` tool, index-backed answers, the "Existing code" section |
| `CONVERSATION_MEMORY` | `on` | a short running summary per conversation, read by `ask_elision` and the resolver; `slm-gate memory` shows it |
| `PROMPT_VERSION` | the shipped value (`v12` at 1.4) | bump it whenever you change either model; cached results are keyed on it |
| `TLS_ADAPTER`, `DISTILL_PRESERVE_PATH` | `on`, the TLS file | as before, when Tech-Lead-Stack is your toolbox |

Keys you do not need to set, because their defaults are the values this setup wants:
`DISTILL_FIDELITY_MIN=1.0` (nothing missing is ever accepted), `DISTILL_FIDELITY_MAX_RUNS=8`,
`DISTILL_FIDELITY_BUDGET_MS=60000`, `MAX_CONCURRENT_SEGMENT_CALLS=2`, `RESOLVER_PROMPT_TOKENS=3000`.

Optional, for this setup: write decisions once in `.slm-gate/decisions/` in each repository (see
[Decision memory](daily-use.md#decision-memory-answer-a-question-once-per-repository)); run `pnpm run fidelity`
to see what shrinking does to your skills, and `pnpm run protections` to see what the guard has learned.

## Setup B: plain shrinking

| Key | Value | Note |
| :--- | :--- | :--- |
| `SLM_BRAIN_MODEL` | `qwen3.5:4b` | the pair |
| `SLM_GATE_MODEL` | `qwen3.5:2b` | the pair |
| `SLM_PIN_MODELS` | `on` | keeps the pair loaded; worth having in both setups |
| `NUM_CTX` | `8192` | must match the Ollama launch file |
| `OLLAMA_KEEP_ALIVE` | `12h` | must match the Ollama launch file |
| `LLM_GATE_DISTILL` | `on` | shrink large tool output in model requests |
| `DISTILL_SKILLS` | `off` | skills go out word for word |
| `REPO_INDEX` | `off` | no index, no `find_existing`, no "Existing code" section |
| `CONVERSATION_MEMORY` | `off` | the local steps answer from a single message, as before |
| `PROMPT_VERSION` | the shipped value (`v12` at 1.4) | the same rule: bump it when you change a model |
| `TLS_ADAPTER`, `DISTILL_PRESERVE_PATH` | `on`, the TLS file | as before |

The fidelity keys, `MAX_CONCURRENT_SEGMENT_CALLS` and `RESOLVER_PROMPT_TOKENS` are read but have nothing to do
in this setup: with `DISTILL_SKILLS=off` no skill paragraph is ever shortened, so the guard never runs. Tool
output (command, search and listing results) is still shrunk by the same rules as before in both setups.

## More memory, bigger models, and running without a cloud model

Both setups above are sized for a 24 GB machine. Nothing in this page is required there; it is what a bigger
machine can do with the same gate.

**What a bigger machine buys.** The local models only ever see a small window of text (`NUM_CTX`, 8,192 tokens
on 24 GB). More unified memory lets you raise two things: the models' size (the brain in the 9B to 14B class,
see the [RAM-by-Machine Model Table](prerequisites-and-hardware.md#ram-by-machine-model-table)) and the window
(`NUM_CTX` 32k to 64k; the key-value cache grows with it, roughly 2 to 3 GB per 32k tokens for a 4B model, more
for bigger ones; `ollama ps` shows the context each loaded model actually got). Put the headroom into the
fidelity guard, decision memory and the repository index first: a bigger brain with a bigger window loses fewer
sentences and answers more questions from your code. The conversation memory (`CONVERSATION_MEMORY`, on in
setup A) hands every local step a few hundred tokens of what the conversation is about; a bigger brain folds
it faster and keeps more of it.

**Reading a whole coding-tool request locally.** A Claude Code request routinely runs 60k to 80k tokens, most
of it history and tool schemas. A 64k window on a 64 GB machine can hold one, but reading it through a local
model takes a minute or more per turn on today's laptops. Treat raw context as the wrong currency for a small
model; a short running summary of the conversation is the right one.

**No cloud model at all.** Ollama answers requests in Anthropic's own format, so Claude Code can be pointed
straight at it with no gate in between: set `ANTHROPIC_BASE_URL=http://localhost:11434` and name a local model.
On a 24 GB machine this is a demonstration, not a workflow: a 4B model cannot carry Claude Code's tool use and
context. On a 64 GB machine a 30B-class coding model with a 64k window is a real local-only setup, and the MCP
gate still earns its place in front of it by shrinking what that local model has to read.

## About the models

The pair above is the 24 GB preset. Other RAM presets use other sizes; see the
[RAM-by-Machine Model Table](prerequisites-and-hardware.md#ram-by-machine-model-table). Whatever the preset,
the two models must be loaded together: Ollama's `OLLAMA_MAX_LOADED_MODELS` should be `2`, exactly the pair.
Check what is loaded with `ollama ps`, never with `ollama run` (that loads the model you name, and evicts one
of the pair). Models that are merely downloaded (`ollama list`) do no harm.

---

[README](../README.md) · [All docs](README.md) · [Configuration](configuration.md) · [Day-to-day use](daily-use.md)
