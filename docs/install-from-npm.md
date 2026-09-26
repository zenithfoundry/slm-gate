# Install from npm

The quickest way to use `slm-gate`. It works with any coding tool that can add an MCP server, with any AI
subscription or API key, or fully on your own computer.

**You need:** a Mac or Linux computer with **16 GB of RAM or more**, [Node.js 22 or newer](https://nodejs.org),
and [Ollama](https://ollama.com/download) installed and running.

## 1. Install the program

```bash
npm install -g @zenithfoundry/slm-gate
```

This installs the program only. It contains no settings, and nobody else's keys.

## 2. Create your settings file

```bash
slm-gate init
```

This creates **one file: `~/.slm-gate/.env`**, a hidden folder in your home folder.

- It is set up for **your computer's RAM**: the two local models and how much text they hold, from the
  [RAM table](prerequisites-and-hardware.md#ram-by-machine-model-table). To set up for another computer, add
  `--ram 64` (any size from 16 GB).
- It holds **every setting**, each one explained in the file: where Ollama is, the local models, ports, optional
  keys, and any toolbox. Edit it with any text editor.
- It is **yours only**: every computer gets its own, it is readable by you alone, and updating `slm-gate` never
  touches it. Your usage history (the ledger) is kept next to it, in `~/.slm-gate/output/`.
- It **never replaces** a settings file that already exists.

`init` then prints the next steps for your computer, starting with the exact `ollama pull` commands.

## 3. Download the local models

Run the `ollama pull …` line `init` printed. For example, on a 64 GB computer:

```bash
ollama pull qwen3.5:4b && ollama pull qwen3.5:9b && ollama pull nomic-embed-text
```

> **Want models that fit your computer better?** Use [llmfit](https://github.com/AlexsJones/llmfit): it measures
> your RAM, GPU and speed and ranks what runs best. Put your choice in `SLM_BRAIN_MODEL` and `SLM_GATE_MODEL` in
> `~/.slm-gate/.env`.

## 4. Check everything

```bash
slm-gate doctor
```

It checks Ollama, the models and your memory, and says exactly what is missing and how to fix it.

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

Where each tool keeps its MCP servers: see the tool's folder in [`configs/`](../configs/). Where those pages say
`node <path>/dist/mcp-gate/index.js`, use the command `slm-gate` with the argument `mcp` instead. Then restart
the tool.

**Optional: let `slm-gate` handle your tool's AI requests too.** Tools that let you change where their AI
requests go (Claude Code, Codex, Gemini CLI, Cline, Continue, OpenCode, Aider and others) can send them through
`slm-gate`, which answers easy first messages on your computer and passes the rest to the same AI company, with
your tool's own login or key. `slm-gate doctor` prints the exact line for each tool.
[Which tools can](integration-layers.md#client-compatibility-matrix).

**Without "no install": npx.** Instead of steps 1 and 5 above, a tool can start `slm-gate` straight from npm:

```json
"slm-gate": { "command": "npx", "args": ["-y", "@zenithfoundry/slm-gate@1", "mcp"] }
```

Run the other commands as `npx -y @zenithfoundry/slm-gate@1 init` (and `doctor`). This can start a little slower,
since npx may check npm first; the global install starts faster and works offline.

## Connect a toolbox (optional)

To put a toolbox behind `slm-gate`, such as [Tech-Lead-Stack](https://github.com/bronz3beard/ai.tech-lead-stack) or any other MCP
server, tell `slm-gate` how to start it with `DOWNSTREAM_MCP`. `slm-gate` then starts it and offers its tools as
its own, so your coding tool only talks to `slm-gate`.

Put it in the coding tool's `slm-gate` entry, so a toolbox's own installer can see that `slm-gate` serves it:

```json
"slm-gate": {
  "command": "slm-gate",
  "args": ["mcp"],
  "env": {
    "DOWNSTREAM_MCP": "{\"command\":\"node\",\"args\":[\"/full/path/to/toolbox/server.mjs\"]}"
  }
}
```

A toolbox that is already running on a web address uses `{"url":"http://localhost:PORT/mcp"}` instead.

## Where settings come from

1. The `env` block of your coding tool's `slm-gate` entry, for that tool only.
2. `~/.slm-gate/.env`, for every tool.
3. Built-in defaults.

The first one found wins. `slm-gate config` shows every setting in effect (keys hidden).

**More than one set of settings** (for example work and personal, with different models): add
`"SLM_GATE_HOME": "/Users/you/.slm-gate-work"` to a tool's `env` block, and run
`SLM_GATE_HOME=/Users/you/.slm-gate-work slm-gate init` once. Each folder has its own settings and history. Give
each its own `LLM_GATE_PORT`.

## Run fully on your own computer

Connect `slm-gate` as in step 5 and set your coding tool's own AI to a local Ollama model (Cline, Continue,
OpenCode and Aider can). Skip the optional AI-requests step: it is for cloud AI.

## Update and uninstall

```bash
npm update -g @zenithfoundry/slm-gate      # update: your settings and history stay as they are
npm uninstall -g @zenithfoundry/slm-gate   # uninstall: ~/.slm-gate stays until you delete it
```

After an update, restart your coding tool. `slm-gate restart` restarts the background model gate.

## Check a download (optional)

Every version is built and signed by this project's release workflow. Its npm page shows **Provenance**, linking
to the exact build, and each [GitHub release](https://github.com/zenithfoundry/slm-gate/releases) carries the same
package with its signature and a list of everything inside it: see [Verifying a release](../SECURITY.md#verifying-a-release).
