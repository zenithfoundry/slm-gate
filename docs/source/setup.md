# Set up from source

Clone, build, test and run `slm-gate` from a git checkout, to change it or contribute.

Just want to use `slm-gate`? Install it from npm instead: [Install](../npm/install.md). This page is for a
checkout of the repository.

**Commands from a checkout.** Every page in these docs writes commands as `slm-gate <command>`. From a checkout,
the same commands run as `pnpm run slm-gate <command>` (from the source, no build needed) or
`node dist/cli.js <command>` (from the build). `slm-gate`'s own warnings always print the full command, so they
work either way. To have the short `slm-gate` command on your path, run `pnpm link --global` in the checkout once
(it needs `pnpm setup` to have been run on your machine).

## 1. Clone and build

You need [Node.js 22 or newer](https://nodejs.org), [pnpm 10](https://pnpm.io/installation), and
[Ollama](https://ollama.com/download) installed and running. 16 GB of RAM or more:
[Hardware](../reference/hardware.md).

```bash
git clone https://github.com/zenithfoundry/slm-gate.git small-language-model-gate
cd small-language-model-gate
pnpm install
pnpm run build
```

`pnpm install` downloads the libraries; `pnpm run build` compiles the TypeScript into `dist/`. No compiler or
Xcode tools are needed: the one native dependency (`better-sqlite3`) ships prebuilt binaries. Run
`pnpm run build` again after changing any `.ts` file.

## 2. Create your settings file

A checkout keeps its settings in `.env` **in the checkout**, not in `~/.slm-gate` (that folder is for the npm
install). Everything else about the file is the same as on npm ([Where settings come from](../npm/install.md#where-settings-come-from)).

```bash
pnpm run slm-gate init --profile proven --provider claude   # or --profile starter | toolbox; --ram 64; --show
```

It writes `.env` for this computer's RAM from the template `.env.example` and prints the `ollama pull` line.
[Profiles](../npm/profiles.md) explains the three profiles. `SLM_GATE_HOME=/full/path` in the environment points a
checkout at another settings folder. The ledger and logs land in `output/` in the checkout, which is gitignored.

## 3. Download the models and check

```bash
ollama pull qwen3.5:4b && ollama pull qwen3.5:2b    # the line init printed for your RAM
pnpm run slm-gate doctor
```

`doctor` checks Ollama, the models, the settings file and the model gate, and prints the line each coding tool
needs to send its AI requests through the gate. Its last line is `READY` when all is well.

## 4. Connect your coding tool to the checkout

The MCP entry runs the built file with Node.js instead of the `slm-gate` command. Every tool page shows the
checkout form under "From a git checkout" ([Connect your tool](../npm/connect-your-tool.md)); for Claude Code:

```bash
claude mcp add --scope user slm-gate -- node "$PWD/dist/mcp-gate/index.js"
```

Then restart the tool. The MCP gate starts the model gate from the same checkout, so after `pnpm run build`
run `pnpm run slm-gate restart` to pick up the new build.

## 5. Test

```bash
pnpm run test               # unit tests, no network and no models
pnpm run test:decoupling    # proves slm-gate compiles and passes with the Tech-Lead-Stack adapter deleted
pnpm run test:e2e           # builds, then end-to-end runs against a live Ollama
```

The house rules for changes are in [AGENTS.md](../../AGENTS.md) and the
[contributing guide](../../.github/CONTRIBUTING.md): structured outputs only, no `stdout` writes on a stdio path,
no hardcoded model tags, `tsc --noEmit` clean.

## Contributor commands

All read the checkout's `.env` and ledger. None needs an API key.

| Command | Does |
| :--- | :--- |
| `pnpm run slm-gate <command>` | Any CLI command from the source: `doctor`, `config`, `memory`, `metrics`, `start`, `stop`, `restart`, `serve`, `ledger:sync`, `ledger:reset --yes`, `setup-dashboard`, `models:check` |
| `pnpm run dev <command>` | The same |
| `pnpm run dashboard` | The local dashboard at `http://localhost:8790` (below) |
| `pnpm run dashboard:export` | Writes the dashboard as a static `site/` folder, numbers and dates only |
| `pnpm run ledger:report` | Tokens saved per UTC day and all-time, from the ledger alone |
| `pnpm run ledger:verify --from <date> --to <date>` | Compares the ledger's events and scores with what Langfuse holds, read-only |
| `pnpm run ledger:wipe-langfuse` | Removes the gate's traces from the Langfuse project |
| `pnpm run langfuse:setup-dashboard` | The same as `slm-gate setup-dashboard` |
| `pnpm run fidelity` | Runs the skill-shrinking guard over every skill in your cache plus three fixtures and prints one outcome per skill (`-- --refresh` re-reads the list of cached skills) |
| `pnpm run protections` | Lists the learned protections, most often hit first; `-- --forget "<sentence>"` removes one |
| `pnpm run bench:gate -- --model qwen3.5:2b` | Compares gate models and concurrency (1 and 2) on this machine; writes to its own ledger file under `output/` |
| `pnpm run elision:stats`, `elision:clean`, `elision:clean:dry`, `elision:clean:old`, `elision:clean:all` | Size of the stored originals of cut lines, and cleanup by age or in full; never touches the savings rows |
| `pnpm run diagrams` | Regenerates the repository's diagrams ([Diagrams](diagrams.md)) |

Fidelity outcomes per skill: `pass` (shortened, every check passed, under budget); `recall_fail` (the brain model
found a sentence missing, so that paragraph went out word for word; reported, not failed); `not_shrunk` (checks
passed but still over budget, sent as the original); `unchanged` (no paragraph long enough to shorten);
`deterministic_fail`, `model_error`, `timeout` (the only outcomes that fail the command). The bench can evict
one of the gate's pinned models while it runs; it warms the gate's model back in when it finishes.

## The dashboard

```bash
pnpm run dashboard            # http://localhost:8790, read-only, only from this computer
```

It reads the ledger and shows window time returned per cycle and provider, tokens saved, weekly charts, the
split of requests sent shrunk against unchanged, the tool definitions each request carried, and the skill
fidelity card. What each card means: [Measure your savings](../npm/measure-savings.md#3-the-dashboard).

**Your coding tools run the npm install?** Then the gate writes to `~/.slm-gate/output/ledger.sqlite`, not the
checkout's `output/ledger.sqlite`. Put `LEDGER_PATH` in front of the command, not in the checkout's `.env`:

```bash
LEDGER_PATH=$HOME/.slm-gate/output/ledger.sqlite pnpm run dashboard
```

The dashboard and the export check this: when the running gate writes to another ledger, they say so and name
the `LEDGER_PATH` to set. Publishing the dashboard to GitHub Pages, and refreshing it daily:
[Analytics: publishing the dashboard](../reference/analytics.md#publishing-the-dashboard).

## Checkout facts worth knowing

- Settings are read once at start: `pnpm run slm-gate restart` after a change.
- The model gate the MCP gate starts is the one in `dist/`. A gate from an older build is reported by `doctor`.
- `output/` holds the ledger, `llm-gate.log`, and the marker files the gates use to agree on who starts what.
- A relative `LEDGER_PATH` fails when a coding tool starts the gate from another folder: leave it blank or give a
  full path ([Settings: the ledger](../reference/settings.md#the-ledger-and-langfuse)).

---

Next: [Switch to npm](switch-to-npm.md)
