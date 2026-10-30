# Settings

Every setting `slm-gate` reads, grouped as the settings file groups them, with its built-in default and when to change it.

The settings file is `~/.slm-gate/.env` for an npm install and `.env` in the checkout for git. `slm-gate init`
creates it from the template `.env.example`, which is the source of truth: every line in it is the built-in
default, and a blank value means "use the default". Settings are read once at start, so run `slm-gate restart`
after a change. Which file wins when a coding tool's `env` block also sets something:
[Where settings come from](../npm/install.md#where-settings-come-from).

Switches take `on` or `off`. Times are in milliseconds. Sizes are in [tokens](../README.md#glossary).

## Settings you may want

The only lines a person decides. `slm-gate init` fills the first four from your RAM and asks for `PROVIDER`.

| Setting | Default | What it does | Change it when |
| :--- | :--- | :--- | :--- |
| `RAM_PRESET` | `custom` | Picks the two local models and `NUM_CTX` when they are blank: `ram-16`, `ram-24`, `ram-32`, `ram-48`, `ram-64`, `ram-128` or `custom` (more than 128 GB: start from the 128 GB models and choose bigger ones). The models per preset: [Hardware](hardware.md#ram-by-machine-model-table). | `init` sets it. Change it with the models when you move to another computer. |
| `SLM_BRAIN_MODEL` | blank (the preset's) | The [brain model](../README.md#glossary): any Ollama tag. | You picked a model with [llmfit](https://github.com/AlexsJones/llmfit). It always wins over `RAM_PRESET`. |
| `SLM_GATE_MODEL` | blank (the preset's) | The [gate model](../README.md#glossary): any Ollama tag. | Same. |
| `NUM_CTX` | `8192` | How much text a local model holds at once. 16 GB: 4096; 24 GB and more: 8192. More context needs more RAM and answers slower; both models' caches must fit next to your apps. | `init` sets it. Lower it first when memory is tight ([Hardware](hardware.md#memory-maths)). |
| `PROVIDER` | blank | The AI provider your coding tool is logged in with: `claude`, `chatgpt` or `gemini`. Used to attribute a request that names no recognisable model, so the savings land under the right provider. Not `SLM_PROVIDER`. Blank: such requests are not attributed. | `init` asks for it. |
| `SUBSCRIPTION_PLAN` | blank | Your plan: `claude-pro`, `claude-max-5x`, `claude-max-20x`, `chatgpt-go`, `chatgpt-plus`, `chatgpt-pro-5x`, `chatgpt-pro-20x`, `gemini-plus`, `gemini-pro`, `gemini-ultra`. Sets the usage window's length and, where one is known, an estimate of its budget ([window budgets](#savings-figures)). Blank: the cycle cards stay empty rather than guess. | You want the "minutes freed" figures. More than one provider: `PLAN_*` below. |
| `DOWNSTREAM_MCP` | blank | A [toolbox](../README.md#glossary) for the MCP gate to sit in front of, as one line of JSON. Paths inside it must be full paths. Blank: the gate offers only its own tools. | You use a toolbox: [Connect a toolbox](../npm/install.md#connect-a-toolbox). |
| `TLS_ADAPTER` | `off` | Keeps Tech-Lead-Stack's skill gates intact and feeds its cost report. `doctor` reports `on` with a blank `DOWNSTREAM_MCP` as an error. | Only when `DOWNSTREAM_MCP` is a Tech-Lead-Stack server. |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` | blank | Mirror the ledger to [Langfuse](https://langfuse.com/). All three or none. | You want Langfuse: [Measure your savings](../npm/measure-savings.md#langfuse-optional). |

## Advanced: safe defaults

Everything below equals the built-in default. Change a line only when a docs page says to.

### The local models

| Setting | Default | What it does | Change it when |
| :--- | :--- | :--- | :--- |
| `SLM_PROVIDER` | `ollama` | Where the local models run: `ollama`, or `openai` for another OpenAI-style server at `OLLAMA_HOST`. | Your computer cannot run Ollama and you want a hosted small model instead (below). |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama's address, as a full URL with `http://`. Ollama's own `OLLAMA_HOST` variable is a bare `host:port`; a value copied from its docs does not work here. If you have Ollama's form exported in your shell, set this line explicitly. | Ollama runs on another port or machine. |
| `OLLAMA_KEEP_ALIVE` | `12h` | How long Ollama keeps a model loaded after its last call (`5m`, `1h`, `12h`, or `-1` for always). | Memory is tight and you accept slower first calls. |
| `SLM_PIN_MODELS` | `on` | Keeps both local models loaded. When something else loads a third model and evicts one of the pair, the model gate unloads the stranger and warms its own model back in, checked every minute. Needs `OLLAMA_MAX_LOADED_MODELS=2` on Ollama's side ([Hardware](hardware.md#keep-both-models-loaded)). | You must run Ollama with one slot; then turn this off, or the two will fight. |
| `TEMPERATURE` | `0` | Randomness of the local models. `0`: the same input gives the same result, and cache hits. | Never, for this tool. |
| `SLM_TIMEOUT_MS` | `120000` | The most time one local-model call may take. Past it the step fails open: the text goes through as it was. | `30000` suits a fast GPU with small models; keep `120000` for 7B to 14B models or CPU inference. |
| `SELF_CONSISTENCY_K` | `3` | When an [open decision](../README.md#glossary) is answered from common practice, the brain model is asked this many times and the answer is kept only when the runs agree. `1` asks once. | The proven and toolbox profiles set `1`. |
| `SELF_CONSISTENCY_TEMP` | `0.7` | The randomness of those re-asks. Must be above 0, or every re-ask is identical. | Rarely. |

**A hosted small model instead of Ollama.** If your computer cannot run Ollama, point the local-model side at an
OpenAI-style server. It reads `OLLAMA_HOST` for the address and `CLOUD_API_KEY` for the key. Hosted models cost
money and add network latency, so the savings are smaller.

```bash
SLM_PROVIDER=openai
OLLAMA_HOST=https://api.openai.com/v1
SLM_BRAIN_MODEL=gpt-4.1-nano
SLM_GATE_MODEL=gpt-4.1-nano
CLOUD_API_KEY=<your key>
```

### The model gate

| Setting | Default | What it does | Change it when |
| :--- | :--- | :--- | :--- |
| `LLM_GATE_PORT` | `8787` | The port coding tools send their AI requests to (`http://localhost:8787`). Set it only in the settings file: a value in a tool's MCP `env` block or your shell is ignored when finding the gate, so every tool uses the same one. | Another program uses the port. Then `slm-gate restart`, and `slm-gate doctor` for the new line per tool. |
| `LLM_GATE_AUTOSTART` | `on` | Start the model gate whenever a coding tool starts the MCP gate, and bring it back within a minute if it stops. `off`: you run `slm-gate start` yourself, and the MCP gate checks Ollama and the models once only. | You want to control the gate by hand. |
| `LLM_GATE_DISTILL` | `on` | Shrink large command, search and listing results before a request leaves your machine. Each result is shrunk once and the same shorter text is resent every later turn, so the provider's prompt cache keeps working. `off`: every request goes out unchanged. | Testing. |
| `UPSTREAM_ANTHROPIC_URL`, `UPSTREAM_OPENAI_URL`, `UPSTREAM_CHATGPT_URL`, `UPSTREAM_GEMINI_URL` | blank | Where each kind of request goes on to. Blank: the provider's own address, chosen from the request. | Only when your company routes all AI traffic through its own gateway. Everyone else leaves them blank. |

Which upstream each login uses. Your tool's own login is sent either way:

| Setting | Subscription login | API key | Default address |
| :--- | :--- | :--- | :--- |
| `UPSTREAM_ANTHROPIC_URL` | Claude Pro/Max in Claude Code | Anthropic API key (Claude Code, Cline and others) | `https://api.anthropic.com` |
| `UPSTREAM_OPENAI_URL` | | OpenAI API key (Codex, Cline and others) | `https://api.openai.com/v1` |
| `UPSTREAM_CHATGPT_URL` | ChatGPT login in Codex | | `https://chatgpt.com/backend-api/codex` |
| `UPSTREAM_GEMINI_URL` | (a Google-account login cannot go through the gate) | Gemini API key (Gemini CLI, `agy`) | `https://generativelanguage.googleapis.com` |

### Conversation memory

The model gate keeps a short running summary of each conversation (the goal, what was decided, the names that
keep coming up), folded by the brain model between requests, never on the request path. The local steps
(`ask_elision`, the open-decisions step) read it beside the message they answer. It lives only in the ledger:
never in event rows, Langfuse or logs. `slm-gate memory` shows it ([Daily use](../npm/daily-use.md#what-the-gate-remembers-of-a-conversation)).

| Setting | Default | What it does | Change it when |
| :--- | :--- | :--- | :--- |
| `CONVERSATION_MEMORY` | `on` | The memory above. `off`: every local step sees one message at a time, and stored summaries are ignored. | You want the behaviour of earlier versions. |
| `MEMORY_MAX_TOKENS` | blank: 400 at `NUM_CTX` 8192, 300 at 4096 | The summary's size. Over it, the "in play" lines go first, then the oldest "decided" lines. | Rarely. Previous summary + new text + answer must fit `NUM_CTX`. |
| `MEMORY_FOLD_INPUT_TOKENS` | blank: 3000 at 8192, 2000 at 4096 | The most new conversation text one fold reads; anything beyond waits for the next fold, nothing is skipped. | Same. |
| `MEMORY_FOLD_INTERVAL_MS` | `20000` | The least time between two folds of one conversation. Turns inside the interval are folded together, and only while the gate has no request in flight. | Rarely. |
| `MEMORY_MATCH_WINDOW_MS` | `600000` | How old a summary may be (ten minutes) before every reader ignores it. | Rarely. |

### The MCP gate

| Setting | Default | What it does | Change it when |
| :--- | :--- | :--- | :--- |
| `MCP_GATE_TRANSPORT` | `stdio` | How your coding tool connects to the MCP gate: `stdio` (the tool starts it) or `http` (then on `MCP_GATE_PORT`, started with `slm-gate serve --layer mcp --transport http`). | Your client connects by web address ([generic HTTP](../../configs/generic-http/README.md)). |
| `MCP_GATE_PORT` | `8788` | The port for `http`. | The port is taken. |
| `REPO_INDEX` | `off` | A small index of the functions, classes and types your repository defines, kept in the ledger and refreshed by file time, with no model. It powers the `find_existing` tool, lets open decisions be answered from the code the question names, and adds an "Existing code that may already cover this" list to conditioned skills. | The proven and toolbox profiles set `on`. |

### Shrinking tool output

Rough guide: 4 characters is a token; 1,000 tokens is about 750 words or 100 lines of code.

| Setting | Default | What it does | Change it when |
| :--- | :--- | :--- | :--- |
| `DISTILL_MIN_TOKENS` | `500` | A result smaller than this is left alone. | Rarely. |
| `DISTILL_MAX_TOKENS` | `2000` | A result larger than this after the fixed rules is where the gate model is asked to shorten plain prose, and where anything still too long is cut, with a marker the agent can expand (`expand_elision`). For `condition_prompt` without a toolbox, this is the only trigger: the fixed rules are picked by tool name. | Rarely. |
| `DISTILL_BUDGET_MS` | `3000` | How long the model gate may hold one request to shrink its new tool results. Past it, a result is sent as it was, and stays that way for the rest of the conversation (prompt cache). Never blocks. | Your local models are slow and you accept a longer pause per turn. |
| `MAX_CONCURRENT_SEGMENT_CALLS` | `2` | Prose runs the gate model shortens at the same time (1 or 2). One GPU serves both models, so 2 is not twice as fast as 1. | `pnpm run bench:gate` from a checkout says 1 is faster on your machine. |
| `DISTILL_SKILLS` | `off` | Also shorten the prose of skill and instruction files, under the [fidelity guard](../README.md#glossary). Lines with rules, tool names, paths, numbers, headings, fences, tables and frontmatter are protected by code and never shown to a model. `off`: skills go through untouched, cut at the ends with a marker when too long. | The proven and toolbox profiles set `on`. |
| `DISTILL_FIDELITY_MIN` | `1.0` | The guard's bar: a shortened paragraph is kept only when the brain model confirms this share of its requirement sentences survived. `1.0`: nothing missing is ever accepted. | Never lower it. |
| `DISTILL_FIDELITY_MAX_RUNS` | `8` | At most this many paragraphs of one skill are shortened and checked; the rest stay word for word. | A bigger brain model and more time per skill. |
| `DISTILL_FIDELITY_BUDGET_MS` | `60000` | Time allowed for shortening one skill; paragraphs past it stay word for word. | Same. |
| `DISTILL_PRESERVE_PATH` | blank | A JSON file of extra text patterns the shrinker must never touch: `{"mode":"extend","patterns":["^## Acceptance Criteria","\\bDEADLINE\\b"]}`. A relative path is read from the install folder, where `configs/preserve/tls.json` ships for Tech-Lead-Stack. The built-ins already protect MUST/SHALL lines, URLs, tables, code and headings ([preserved patterns](../../configs/preserve/README.md)). | The toolbox profile sets the Tech-Lead-Stack file. Your toolbox has rules of its own. |
| `DISTILL_PRESERVE_MODE` | `extend` | `extend`: your patterns are added to the built-ins. `replace`: only yours. | Use `extend`. |
| `DISTILL_ADAPTIVE` | `off` | Learn from expansions: when the agent asks for lines that were shrunk away, remember their meaning and protect lines that mean the same next time. Needs a third local model (`EMBED_MODEL`) and more RAM. | You have the RAM and expansions are frequent. Then `ollama pull nomic-embed-text`. |
| `DISTILL_ADAPTIVE_THRESHOLD` | `0.86` | How similar a line must be to a remembered one to be protected. | Rarely. |
| `DISTILL_ADAPTIVE_EXPLORE_RATE` | `0.15` | The share of unprotected lines checked against memory, to bound the cost. | Rarely. |
| `ELISION_RETENTION_DAYS` | `180` | Every shrunk result's original is kept in the ledger so the agent can get cut lines back without re-running the tool. Rows older than this go. | Disk space. |
| `ELISION_MAX_MB` | `500` | Past this size, the least recently used originals go first. | Disk space. |
| `PROMPT_VERSION` | `v12` | Part of every cache key. | Move it up (`v12` to `v13`) after swapping a local model or when release notes say to; every cached result is then redone. |

### The resolver's API model

The open-decisions step may send an unclear request to a paid API model as a last resort. This costs per-token
dollars on top of your subscription; every call is logged in the ledger. The model gate never uses these
settings: it forwards each tool's own login.

| Setting | Default | What it does | Change it when |
| :--- | :--- | :--- | :--- |
| `RESOLVER_CLOUD_TIER` | `off` | Allow that last-resort call. Needs the `CLOUD_*` lines. | You want it, and accept the cost. |
| `RESOLVER_CLOUD_BUDGET_USD` | `0` | Caps the lifetime spend. `0`: never spend. | Same. |
| `RESOLVER_PROMPT_TOKENS` | blank: 3000 at `NUM_CTX` 8192, 2000 at 4096 | The most skill text the brain model is given in one prompt when it looks for open decisions; longer skills are trimmed by section. The whole prompt must fit `NUM_CTX`. | Rarely. |
| `CLOUD_API_STYLE` | `openai` | The API model's format: `openai` or `anthropic`. Gemini uses `openai`, at `https://generativelanguage.googleapis.com/v1beta/openai/`. | With the cloud tier or `SLM_PROVIDER=openai`. |
| `CLOUD_BASE_URL`, `CLOUD_API_KEY`, `CLOUD_MODEL` | blank | Its address, key and model name. | Same. |
| `SEMCACHE` | `off` | Reuse the open-decisions step's results for requests that mean the same thing, by embedding similarity. Needs `EMBED_MODEL` pulled. | You have the RAM for a third model. |
| `SEMCACHE_THRESHOLD` | `0.95` | How similar two requests must be (`0.95`: near-identical). | Rarely. |
| `EMBED_MODEL` | `nomic-embed-text` | The embedding model `SEMCACHE` and `DISTILL_ADAPTIVE` use. Only needed, and only loaded, when one of them is on. | Rarely. |

### Savings figures

The dashboard's cycle cards turn tokens saved into minutes of your provider's [usage window](../README.md#glossary):

```text
estimated minutes saved = units saved × (window minutes ÷ window budget)
```

The budget comes from your plan (`SUBSCRIPTION_PLAN`, or `PLAN_*` per provider), as an estimate. A measured
`*_WINDOW_BUDGET` wins over the estimate. With no plan and no budget, that provider's cards stay empty, and
`slm-gate doctor` says so. **Every figure here is an estimate within a margin of error:** providers publish no
limits, only multipliers between plans.

| Setting | Default | What it does | Change it when |
| :--- | :--- | :--- | :--- |
| `PLAN_CLAUDE`, `PLAN_CHATGPT`, `PLAN_GEMINI` | blank | One plan per provider when you use more than one. Each wins over `SUBSCRIPTION_PLAN` for its provider. | You pay two providers. |
| `CLAUDE_WINDOW_BUDGET`, `CHATGPT_WINDOW_BUDGET`, `GEMINI_WINDOW_BUDGET` | blank | A measured budget for your window: tokens per window for Claude and Gemini, messages per window for ChatGPT. | You measured one: budget = tokens sent in a window ÷ share of the window used (Claude Code shows the share with `/usage`). |
| `PROVIDER_REGISTRY_PATH` | blank | A JSON file that overrides the built-in provider registry (window lengths, model-name patterns). | A provider changed its window and no release has caught up. |

The plans and their estimates, from `src/pricing/plans.ts`:

| Plan | Window | Estimated budget | Where the number comes from |
| :--- | :--- | :--- | :--- |
| `claude-pro` | 5 h | 460,000 tokens | Max 5x measured 2026-09-16 (tokens sent ÷ `/usage` share); Pro and 20x scaled by Anthropic's multipliers |
| `claude-max-5x` | 5 h | 2,300,000 tokens | |
| `claude-max-20x` | 5 h | 9,200,000 tokens | |
| `chatgpt-go` | 5 h | none known | OpenAI publishes no per-window number for Go |
| `chatgpt-plus` | 3 h | 160 messages | Third-party reports, 2026 |
| `chatgpt-pro-5x`, `chatgpt-pro-20x` | 3 h | none known | |
| `gemini-plus` | 5 h | none known | |
| `gemini-pro` | 5 h | 500,000 tokens | Assumed close to Claude Pro |
| `gemini-ultra` | 5 h | 10,000,000 tokens | 20x AI Pro, per Google's plan page |

For Claude and Gemini, every token saved counts, including tool results shrunk by the MCP gate. **ChatGPT meters
messages**, and a shrunk request still costs one message, so nothing the gate does frees a ChatGPT message:
ChatGPT's cards can only show 0 today.

### The ledger and Langfuse

| Setting | Default | What it does | Change it when |
| :--- | :--- | :--- | :--- |
| `LEDGER_PATH` | blank: `output/ledger.sqlite` in the settings folder, as a full path | Where the [ledger](../README.md#glossary) lives. | You keep it elsewhere. Then give a **full path**, below. |
| `LANGFUSE_ENVIRONMENT` | `slm-gate` | The Langfuse environment the gate's traces land in (lowercase letters, digits, `-` and `_`; not starting with `langfuse`; not `default`). Keeps the gate's traffic its own. | Rarely. |
| `LANGFUSE_RETENTION_DAYS` | `30` | How many days of data your Langfuse plan keeps (Hobby: 30). Only the dashboard text reads it. | Your plan keeps more. |

**`LEDGER_PATH` must be a full path.** Your coding tool starts the gate from a folder of its choosing; Claude
Desktop starts MCP servers from a folder that does not exist. A relative value such as `./output/ledger.sqlite`
is resolved against that folder, so the server fails at start with `ENOENT: no such file or directory, mkdir
'./output'`, while the same value looks fine from a terminal. Two rules:

- **Blank is safe.** The default is already a full path: `~/.slm-gate/output/ledger.sqlite` on npm,
  `output/ledger.sqlite` in a checkout.
- **If you set it, set the full path.** `slm-gate doctor` reports an issue for any value that is not one. The
  same rule applies to every path inside `DOWNSTREAM_MCP`.

`slm-gate metrics`, `slm-gate ledger:sync` and `slm-gate ledger:reset --yes` all read this setting, so they
land on the same file as the gates.

---

Next: [Hardware](hardware.md)
