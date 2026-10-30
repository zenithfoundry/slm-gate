# How it works

The path a tool call and a model request take through the two gates, how the gates start, and what the ledger records.

`slm-gate` is two small servers on your computer, between your coding tool and the outside world. Both use the
two local models run by Ollama. If a local model fails or runs out of time, the text it was working on goes on as
it was. Neither gate ever answers a request itself.

- **Tool calls** go through the **MCP gate**. It passes each call to your [toolbox](../README.md#glossary), then
  shrinks long text in the result before your coding tool sees it.
- **Model requests** go through the **model gate**. It shrinks new command, search and listing output in the
  request and sends it to your AI provider with your own login.

The big picture, with what each gate saves, is in the [README](../../README.md#how-it-works). This page follows
one tool call, one model request, and the start-up.

## What each gate can see

The MCP gate only sees what tools send back (skill files, file contents, command output). It never sees the
messages you type, so it can only shrink those results. The model gate sits between your coding tool and the
model, so it sees every request: it shrinks the large tool output in each one before it leaves your machine, and
keeps a short memory of each conversation that the local steps of both gates read.

| Savings figure | Needs |
| :--- | :--- |
| Tokens saved, cost saved, shrunk against unchanged | either gate |
| Claude or Gemini cycle cards | either gate, and a plan or window budget ([Settings](settings.md#savings-figures)) |
| ChatGPT cycle cards | can only show 0 today: ChatGPT meters messages, and every message is still sent |

## What happens to a tool call (MCP gate)

The MCP gate passes each tool call to your toolbox unchanged. When the result comes back, it works on the text
only: pictures, structured data and the error flag go back as the toolbox sent them. The gate adds tools of its
own: `expand_elision` fetches back any lines it cut; `ask_elision` lets the coding model ask a question about the
cut text and get a few sentences from the brain model instead of a 2,000-token page; and, with `REPO_INDEX=on`,
`find_existing` lists the functions, classes and types your repository already defines that match a few words.
With no toolbox set, the gate also offers `condition_prompt`, which runs the same steps on text you send it.

![One tool call, step by step: the MCP gate passes it to the toolbox unchanged, sends only the text to be shrunk (saved result first, then the gate model's shortening with the fidelity guard for skills, then the project scan and open decisions with the brain model, optionally an API model), logs a row and returns the smaller result; later the tool can ask for the cut lines, the original or the symbol index](../diagrams/tool-call.png)

Explore it: [tool-call.html](../diagrams/tool-call.html) (open in a browser; nodes expand, paths can be traced).

| Step | File | What it does |
| :--- | :--- | :--- |
| Saved result | `src/ledger/index.ts`; `src/cache/index.ts` with `SEMCACHE=on` | If the same tool returned the same text before, sends the saved result and skips the steps below. With `SEMCACHE=on`, very similar text counts too. |
| Shrink | `src/utils/elision.ts` | Leaves text under `DISTILL_MIN_TOKENS` alone. Otherwise saves the original for `expand_elision`, then cuts by tool name: a file keeps its outline and the lines about the task, a log keeps its errors and last 50 lines, a search keeps its first 50 lines. If it is still over `DISTILL_MAX_TOKENS`, the gate model shortens the plain prose, never code blocks, tables, headings, frontmatter, rule lines, tool names, paths or numbers with units (and never file reads). Skills are shortened only with `DISTILL_SKILLS=on`, under the [fidelity guard](../README.md#glossary). Anything still too long keeps only its start and end. |
| Project scan | `src/mcp-gate/ground.ts` | Reads the project's root files (`package.json`, `tsconfig.json`, lockfiles, `Cargo.toml`, `go.mod`) and adds a short list of what the project uses. Only when your coding tool shares the project folder. |
| Open decisions | `src/resolver/index.ts` | The brain model lists up to 3 [open decisions](../README.md#glossary) in the text and answers each from a decision you wrote down once in `.slm-gate/decisions/`, from the symbols the question names when `REPO_INDEX=on`, from your project's files, or from common practice; the gate model rates each one's risk. Low-risk answers found in your files are added as decided; the rest are added as questions to ask you, with a suggested answer. With `RESOLVER_CLOUD_TIER=on` and a budget, unsure ones go to a paid API model. |

The fixed cutting rules are picked by **tool name**, so they apply only when the gate can see which tool produced
the output. A `condition_prompt` call carries no tool name, so its only path is the gate model's shortening,
which engages above `DISTILL_MAX_TOKENS`.

## What happens to a model request (model gate)

The model gate is a small server at `http://localhost:8787`. It reads four request formats (Anthropic Messages,
OpenAI Chat Completions, OpenAI Responses and Gemini) and makes one change before anything goes to your provider:

- **Shrink.** New command, search and listing output of at least `DISTILL_MIN_TOKENS` is cut the same way as in
  the MCP gate. File reads (including `cat` and similar run from a shell), web fetches and MCP tool results are
  never changed. Each decision is saved and resent unchanged on every later turn, so the provider's prompt cache
  keeps working. At most `DISTILL_BUDGET_MS` (3 seconds); after that, the original goes.

The request then goes to the provider its address belongs to, with every header your coding tool sent, so your
own login or API key is used; `slm-gate` never adds or swaps credentials. The reply streams back unchanged. Once
the reply is done, the turn is noted for the conversation memory; the brain model folds it into the summary
later, only while the gate has no request in flight. Token counts, model lists and hello pings skip all of this.

![One model request, step by step: the model gate shrinks new command, search and listing output (a saved decision is reused; the gate model shortens new output), forwards the smaller request to your provider with every header the tool sent, streams the reply back unchanged, logs a row, notes the turn, and later, while idle, the brain model folds the turn into the conversation memory](../diagrams/model-request.png)

Explore it: [model-request.html](../diagrams/model-request.html) (open in a browser; nodes expand, paths can be traced).

**Try it.** Start a new conversation and ask for real work, such as "list the files in this folder and tell me
what they do". It goes to your provider as normal. When the tool runs commands, their large output is shrunk
before the next request leaves your machine. Then read the newest rows:

```bash
sqlite3 ~/.slm-gate/output/ledger.sqlite "SELECT route, api_in_tok FROM events WHERE layer = 'llm' ORDER BY ts DESC LIMIT 5;"
```

```text
forward_compressed|8200
forward_raw|1450
memory_fold|0
```

- `forward_compressed`: sent to your provider with some tool output shrunk. The number is roughly how many
  tokens went out.
- `forward_raw`: sent unchanged; nothing was large enough to shrink. Normal for short conversations.
- `memory_fold`: the brain model folded a turn into the conversation memory. Nothing was sent to your provider.
- `defer_local`: only in ledgers written before 1.4. Those rows still count in the totals.

Every row `forward_raw`? Nothing in those requests was large enough (`DISTILL_MIN_TOKENS`), or Ollama is not
running, in which case the gate sends everything unchanged; `slm-gate doctor` says. No rows at all? Your tool is
not using the gate yet: check its address setting and restart it.

## Who pays for what

Neither gate needs an API key of its own. Every request that reaches the cloud is billed exactly as it would be
without `slm-gate`: to the subscription or API key your coding tool is logged in with. `slm-gate` only makes those
requests smaller. The `CLOUD_*` settings are separate and optional: only the open-decisions step's cloud tier and
`SLM_PROVIDER=openai` read them.

**Only programs on this computer** can reach the gate. It listens on `127.0.0.1` and `::1` only, accepts only
`localhost` host names, and refuses requests from web pages. Other computers, Docker containers and virtual
machines cannot connect. Refused requests get 403 and are neither forwarded nor recorded.

## How it starts, and what the CLI does

You rarely start anything by hand. Your coding tool starts the MCP gate. Before the MCP gate answers the tool
(it waits at most 1.5 seconds), it starts the model gate in the background if nothing is running on its port,
and checks that Ollama is running and every model your settings name is downloaded. It checks again 15 seconds
later and then every minute, restarting the model gate if it stopped, unless you stopped it with `slm-gate stop`.
With `LLM_GATE_AUTOSTART=off` it never starts the model gate and checks once only. It never starts Ollama or
downloads a model. Problems show up as a desktop notification, and problems found at start-up are also passed to
your AI assistant. The CLI is for doing this by hand, and for checks and reports.

![How it starts: the coding tool starts the MCP gate, which runs the start-up checks at start, after 15 s and then every minute; the checks ask Ollama whether it is running and the models are downloaded, start the model gate if nothing is on its port, and report problems as a desktop notification (at start-up also to your AI assistant); you can start, stop, restart or serve the model gate by hand with the CLI](../diagrams/startup.png)

Explore it: [startup.html](../diagrams/startup.html) (open in a browser; nodes expand, paths can be traced).

| Command | Runs | Does |
| :--- | :--- | :--- |
| `init --profile <name> --provider <name>` | `src/setup/init.ts` | Creates the settings file for this computer's RAM and the chosen [profile](../npm/profiles.md); `--ram <GB>`, `--show` |
| `mcp` | `src/mcp-gate/index.ts` | The MCP gate; what a coding tool registers. Starts the model gate |
| `start`, `stop`, `restart` | `src/setup/gate-command.ts` | Starts or stops the background model gate; `stop` lasts until `start`, `restart` or a reboot |
| `serve` | `src/llm-gate/index.ts` | Runs the model gate in this terminal (`--layer mcp` or `both` runs the MCP gate too) |
| `doctor` | `src/doctor.ts` | Preflight checks, and the exact line to paste into each coding tool |
| `config` | `src/config.ts` | Prints your settings |
| `memory` | `src/llm-gate/memory.ts` | What the gate remembers of each conversation |
| `models:check` | `src/models/check.ts` | Checks your models are downloaded and fit in memory |
| `metrics` | `src/metrics.ts` | Rows, tokens and cost in the ledger |
| `ledger:sync` | `src/ledger/sync.ts` | Sends ledger history to Langfuse |
| `setup-dashboard` | `src/ledger/setup-dashboard.ts` | Builds the Langfuse dashboard |
| `ledger:reset --yes` | `src/ledger/reset.ts` | Deletes the ledger `LEDGER_PATH` names |

Several MCP gates at once (one per editor window or CLI session) agree through marker files in `output/`: one
launch per minute, one desktop notification per problem per ten minutes, and a stop marker from `slm-gate stop`
that holds until the next `start`, `restart` or reboot. The model gate is launched with every setting removed
from its environment, so it takes its settings only from the settings file
([Where settings come from](../npm/install.md#where-settings-come-from)). More detail: [Architecture](../../ARCHITECTURE.md).

## Where the data goes

Both gates write one row to the [ledger](../README.md#glossary) for each tool result the MCP gate shrinks and
each model request the model gate forwards (and one per memory fold). A row holds token counts, the route taken
and timings, not the text itself. Rows for your coding tool's traffic carry no price; only the optional cloud
call of the open-decisions step records one. The same file also keeps saved results, the original of anything
cut (for `expand_elision`), the model gate's shrink decisions, the conversation memory and the learned
protections. Reading it: [Measure your savings](../npm/measure-savings.md) and [Analytics](analytics.md).

---

Next: [Analytics](analytics.md)
