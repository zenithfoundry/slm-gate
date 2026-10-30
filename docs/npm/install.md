# Install from npm

Install `slm-gate`, create your settings, download the two local models, and connect your coding tool.

**You need:** a Mac or Linux computer with **16 GB of RAM or more**, [Node.js 22 or newer](https://nodejs.org),
and [Ollama](https://ollama.com/download) installed and running. Which models fit your computer:
[Hardware](../reference/hardware.md).

**Rather answer questions than follow steps?** Do step 1, then paste the
[AI setup prompt](ai-assisted-setup.md) into any AI assistant. It does the rest with you.
**Using a git checkout today?** [Switch to npm](../source/switch-to-npm.md).

## 1. Install the program

```bash
npm install -g @zenithfoundry/slm-gate
```

This installs the program only. It holds no settings and nobody's keys.

## 2. Create your settings file

```bash
slm-gate init
```

This creates **one file, `~/.slm-gate/.env`**, in a hidden folder in your home folder.

- It is set up for **your computer's RAM**: the two local models and how much text they hold at once, from the
  [RAM table](../reference/hardware.md#ram-by-machine-model-table). For another computer, add `--ram 64` (any
  size from 16 GB).
- It asks which **AI provider** your coding tool is logged in with (claude, chatgpt or gemini), so the savings
  figures land under the right name. Pass it with `--provider claude` to skip the question.
- It starts from the **starter profile**. `--profile proven` or `--profile toolbox` turn more on:
  [Profiles](profiles.md). `--show` prints the lines `init` would set without writing anything.
- It holds **every setting**, each one explained above its line. Edit it with any text editor. Every line
  below "Advanced" is the built-in default, so a blank value is always safe.
- It is **yours only**: every computer gets its own, it is readable by you alone, and updating `slm-gate` never
  touches it. Your savings history (the [ledger](../README.md#glossary)) is kept next to it, in
  `~/.slm-gate/output/`.
- It **never replaces** a settings file that already exists.

`init` then prints the next steps for your computer, starting with the exact `ollama pull` line.

## 3. Download the local models

Run the `ollama pull` line `init` printed. For example, on a 24 GB computer:

```bash
ollama pull qwen3.5:4b && ollama pull qwen3.5:2b
```

These are the [brain model and the gate model](../README.md#glossary), `SLM_BRAIN_MODEL` and `SLM_GATE_MODEL`.
No third model is needed unless you turn on `DISTILL_ADAPTIVE` or `SEMCACHE` later
([Settings](../reference/settings.md#shrinking-tool-output)).

> **Want models that fit your computer better?** [llmfit](https://github.com/AlexsJones/llmfit) measures your
> RAM, GPU and speed and ranks what runs best. Put your choice in `SLM_BRAIN_MODEL` and `SLM_GATE_MODEL` in
> `~/.slm-gate/.env`, then run `slm-gate restart`.

## 4. Check everything

```bash
slm-gate doctor
```

It checks Ollama, the models and your memory, and says exactly what is missing and how to fix it. Its last line
is `READY` when all is well. It also prints the line each coding tool needs to send its AI requests through the
gate (step 5).

## 5. Connect your coding tool

Add an MCP server to your coding tool. It is always the same two things: the command **`slm-gate`** and the
argument **`mcp`**. Name it `slm-gate`.

```json
"slm-gate": { "command": "slm-gate", "args": ["mcp"] }
```

For Claude Code, that is one command:

```bash
claude mcp add --scope user slm-gate -- slm-gate mcp
```

Where each tool keeps its MCP servers, in which format, and which tools can also send their AI requests through
the gate: [Connect your tool](connect-your-tool.md). Then restart the tool.

**Without installing: npx.** Instead of steps 1 and 5, a tool can start `slm-gate` straight from npm:

```json
"slm-gate": { "command": "npx", "args": ["-y", "@zenithfoundry/slm-gate@1", "mcp"] }
```

Run the other commands as `npx -y @zenithfoundry/slm-gate@1 init` (and `doctor`). Step 2 is still needed:
the entry above only starts `slm-gate`, and the model gate it starts reads `~/.slm-gate/.env` alone
([Where settings come from](#where-settings-come-from)). npx may check npm first, so it starts a little
slower; the global install starts faster and works offline.

## Upgrade and uninstall

```bash
npm update -g @zenithfoundry/slm-gate      # your settings and history stay as they are
slm-gate restart                           # the background model gate picks up the new version
npm uninstall -g @zenithfoundry/slm-gate   # ~/.slm-gate stays until you delete it
```

After an upgrade, restart your coding tool too.

## Where settings come from

`slm-gate` runs as two programs. Each coding tool starts its own **MCP gate**, and the first one to start also
starts the **model gate** in the background, which every coding tool then shares.

1. The `env` block of a coding tool's `slm-gate` entry, for that tool's MCP gate only.
2. `~/.slm-gate/.env`, for everything.
3. Built-in defaults.

The first one found wins, with one rule: **the model gate reads only `~/.slm-gate/.env`.** It never reads any
coding tool's `env` block, so that no single tool decides the gate's settings for all the others. Neither gate
reads a project's `.env`. `slm-gate config` shows every setting in effect (keys hidden).

- **Put the local models, ports and keys in `~/.slm-gate/.env`**, not in a coding tool's `env` block. Use the
  `env` block only for a setting meant for that one tool, such as a different `DOWNSTREAM_MCP` or
  `SLM_GATE_HOME`.
- **Without `~/.slm-gate/.env`, the gate uses built-in default models**, whatever a tool's `env` block says.
  Every session then warns you, and so does `slm-gate doctor`. Run `slm-gate init`, the `ollama pull` line it
  prints, then `slm-gate restart`.
- Settings are read once at start: run `slm-gate restart` after a change.

**More than one set of settings** (for example work and personal, with different models): add
`"SLM_GATE_HOME": "/Users/you/.slm-gate-work"` to a tool's `env` block, and run
`SLM_GATE_HOME=/Users/you/.slm-gate-work slm-gate init` once. Each folder has its own settings and history. Give
each its own `LLM_GATE_PORT`.

## Connect a toolbox

A [toolbox](../README.md#glossary) is any MCP server you put behind the gate, such as
[Tech-Lead-Stack](https://github.com/bronz3beard/ai.tech-lead-stack). `slm-gate` starts it and offers its
tools as its own, so your coding tool only talks to `slm-gate`, and every large result is shrunk on the way back.

`DOWNSTREAM_MCP` says how to start it: one line of JSON in `~/.slm-gate/.env`.

```bash
# Tech-Lead-Stack from npm (what `slm-gate init --profile toolbox` writes, with TLS_ADAPTER=on)
DOWNSTREAM_MCP={"command":"npx","args":["-y","tech-lead-stack@1"]}
# a server you built yourself; paths must be full paths
DOWNSTREAM_MCP={"command":"node","args":["/full/path/to/dist/mcp-server.mjs"]}
# a server already running at a web address
DOWNSTREAM_MCP={"url":"http://localhost:PORT/mcp"}
```

- Tech-Lead-Stack also wants `TLS_ADAPTER=on`, which keeps its skill gates intact and feeds its cost report.
  `slm-gate doctor` reports `TLS_ADAPTER=on` with a blank `DOWNSTREAM_MCP` as an error.
- To give one coding tool a different toolbox, put `DOWNSTREAM_MCP` in that tool's `env` block instead. It is
  stored as text, so in a JSON file escape its quotes. Each tool page shows the entry.
- Keep the gate registered as `slm-gate` whatever sits behind it. When a toolbox's own commands name its tools
  under another server (`mcp__tech-lead-stack__get_skills`), the gate tells your coding tool those tools live on
  `slm-gate` and rewrites the names in what it returns.
- If the tool also lists the toolbox as its own separate entry, remove that entry, or its tools appear twice.
- Without a toolbox, the MCP gate offers only its own tools: `condition_prompt`, which runs the same shrinking on
  text you send it, and `expand_elision`, `ask_elision` and `find_existing`.

Run `slm-gate restart` after the change. `slm-gate doctor` checks the toolbox starts.

## Run fully on your own computer

Connect `slm-gate` as in step 5 and set your coding tool's own AI to a local Ollama model (Cline, Continue,
OpenCode and Aider can). Skip the AI-requests line `doctor` prints: it is for cloud AI.

## Check a download

Every version is built and signed by this project's release workflow. Its npm page shows **Provenance**, linking
to the exact build, and each [GitHub release](https://github.com/zenithfoundry/slm-gate/releases) carries the
same package with its signature and a list of everything inside it: [Verifying a release](../../SECURITY.md#verifying-a-release).

---

Next: [Profiles](profiles.md)
