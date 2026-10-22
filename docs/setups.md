# The Two Setups

`slm-gate` runs in one of two setups. Both use the same pair of local models and the same settings file; they
differ in how much work the local models take on. Every other setting is documented in
[Configuration](configuration.md) and can be changed freely in either setup.

| | **Setup A: local models do more** | **Setup B: plain shrinking** |
| :--- | :--- | :--- |
| Skills (your toolbox's instructions) | shortened by the gate model under a guard that fails closed | sent word for word, cut at the ends with a marker when too long |
| Open questions in a skill | answered from a decision you wrote once, from the code the question names, then from files | answered from files and common practice |
| Tools the gate adds | `expand_elision`, `ask_elision`, `find_existing` | `expand_elision`, `ask_elision` |
| Extra local-model work per skill | up to 8 short paragraph checks by the brain model, inside 60 s | none |
| What it costs you | a few seconds more on a skill's first conditioning; cached after | nothing extra |
| Choose it when | you want the savings the local models can give and the dashboard's fidelity card to tell you what they cost | you want the behaviour of earlier versions, or your toolbox's skills must never be reworded |

Switching between them is two lines in `.env` and `slm-gate restart`. Nothing else changes, and nothing in the
ledger is lost.

## Setup A: local models do more

| Key | Value | Note |
| :--- | :--- | :--- |
| `SLM_BRAIN_MODEL` | `qwen3.5:4b` | the pair: answers, checks, decides |
| `SLM_GATE_MODEL` | `qwen3.5:2b` | the pair: sorts, shortens, rates risk |
| `SLM_PIN_MODELS` | `on` | keeps the pair loaded; evicts a third model that displaced one of them |
| `NUM_CTX` | `8192` | must match the Ollama launch file (`OLLAMA_CONTEXT_LENGTH`) |
| `OLLAMA_KEEP_ALIVE` | `12h` | must match the Ollama launch file (`OLLAMA_KEEP_ALIVE`) |
| `LLM_GATE_DISTILL` / `LLM_GATE_LOCAL_FIRST` | `on` / `on` | the model gate's two steps: shrink, and try the first message locally |
| `DISTILL_SKILLS` | `on` | skill shrinking under the fidelity guard |
| `REPO_INDEX` | `on` | the `find_existing` tool, index-backed answers, the "Existing code" section |
| `PROMPT_VERSION` | `v10` | bump it whenever you change either model; cached results are keyed on it |
| `TLS_ADAPTER`, `DISTILL_PRESERVE_PATH` | `on`, the TLS file | as before, when Tech-Lead-Stack is your toolbox |

Keys you do not need to set, because their defaults are the values this setup wants:
`DISTILL_FIDELITY_MIN=1.0` (nothing missing is ever accepted), `DISTILL_FIDELITY_MAX_RUNS=8`,
`DISTILL_FIDELITY_BUDGET_MS=60000`, `MAX_CONCURRENT_SEGMENT_CALLS=2`, `RESOLVER_PROMPT_TOKENS=3000`,
`ROUTING_TUNE=off`. Turn `ROUTING_TUNE` on only if you want per-turn routing data collected; it is one gate-model
call per message you type.

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
| `LLM_GATE_DISTILL` / `LLM_GATE_LOCAL_FIRST` | `on` / `on` | the model gate's two steps, as before |
| `DISTILL_SKILLS` | `off` | skills go out word for word |
| `REPO_INDEX` | `off` | no index, no `find_existing`, no "Existing code" section |
| `PROMPT_VERSION` | `v10` | the same rule: bump it when you change a model |
| `TLS_ADAPTER`, `DISTILL_PRESERVE_PATH` | `on`, the TLS file | as before |

The fidelity keys, `MAX_CONCURRENT_SEGMENT_CALLS` and `RESOLVER_PROMPT_TOKENS` are read but have nothing to do
in this setup: with `DISTILL_SKILLS=off` no skill paragraph is ever shortened, so the guard never runs. Tool
output (command, search and listing results) is still shrunk by the same rules as before in both setups.

## About the models

The pair above is the 24 GB preset. Other RAM presets use other sizes; see the
[RAM-by-Machine Model Table](prerequisites-and-hardware.md#ram-by-machine-model-table). Whatever the preset,
the two models must be loaded together: Ollama's `OLLAMA_MAX_LOADED_MODELS` should be `2`, exactly the pair.
Check what is loaded with `ollama ps`, never with `ollama run` (that loads the model you name, and evicts one
of the pair). Models that are merely downloaded (`ollama list`) do no harm.

---

[README](../README.md) · [All docs](README.md) · [Configuration](configuration.md) · [Day-to-day use](daily-use.md)
