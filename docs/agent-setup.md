# Set up slm-gate with an AI assistant

A prompt you can paste into any AI assistant: Claude Code, Codex, Gemini CLI, or a chat app. It checks your computer,
asks you a few questions, then sets up `slm-gate` for the way you work: your settings file, the local models, your
coding tools, and any toolbox. When it is done, `slm-gate` is running with both local models loaded, and every
tool you chose is connected.

**Use it when** you would rather answer questions than read guides, or when you are moving from a git checkout to
the npm install: it sets everything up fresh and copies nothing from the old folder
([Switch slm-gate to npm](./switch-to-npm.md) walks through that, and how to bring old settings back). **Read
[Install from npm](./install-from-npm.md) instead** if you prefer to do it yourself.

**What it can't do:** install Node.js or Ollama for you, type your passwords or keys, or quit and reopen your
coding tools. It tells you exactly what to do for each, then waits until you say you're ready.

## Before you start

Install `slm-gate` (this needs [Node.js 22 or newer](https://nodejs.org)):

```bash
npm install -g @zenithfoundry/slm-gate
```

Missing Node.js, or [Ollama](https://ollama.com/download)? Paste the prompt anyway: it checks, sends you to the right
download page, and carries on when you say you're ready.

## The prompt

Open your AI assistant, ideally one that can run commands on your computer (Claude Code, Codex, Gemini CLI and
similar). Paste everything between the lines.

```text
You are setting up slm-gate on my computer. slm-gate runs small AI models on this computer (with Ollama) to make
my paid AI plan last longer. Work through the steps below in order.

RULES
- First, ask me how comfortable I am with the terminal: (a) not at all, (b) a little, or (c) very. Default: (b).
  For (a) and (b), explain each step in one plain sentence and avoid technical words. For (c), be brief.
- Look before you ask. Run the checks in each step and tell me what you found. Don't ask me what a command can
  tell you.
- Ask one question at a time, offer a sensible default, and wait for my answer.
- Use only the settings in ALLOWED SETTINGS and the commands in ALLOWED COMMANDS at the end of this prompt.
  Anything not listed there does not exist: say so plainly and ask me how to proceed. Never invent a setting,
  a command, or an option.
- Before you change any file: show me the exact change, make a backup copy next to it named
  <file>.backup-<date and time> (for example `cp -p ~/.slm-gate/.env ~/.slm-gate/.env.backup-20260926-1430`),
  and wait for my yes. Never delete a file. Remove something from a settings file only when I say yes.
- Never ask me to paste a password, API key or token into this chat. Leave the value blank in the file, tell me
  the file and line, and I will type it in myself.
- If you cannot run commands yourself, give me one command at a time, tell me what it does in one sentence,
  and wait for me to paste back what it printed.
- If something I need is missing (Node.js, Ollama, enough memory), stop. Tell me what is missing, why it is
  needed, and give me the official link below. Then wait until I say "ready", check again, and carry on.
- slm-gate works on macOS and Linux only. On Windows, stop and tell me it is not supported yet.
- Never run `slm-gate ledger:reset`, `npm uninstall`, `rm`, or anything else that erases data. If something
  should be removed, give me the command and let me run it.

STEP 1 — CHECK THE BASICS
Check each one, and report a short list with ✓ or ✗:
- The system: `uname -s`. Darwin means macOS; Linux is fine; anything else, stop.
- Memory: on macOS `sysctl -n hw.memsize` (bytes; divide by 1073741824 for GB); on Linux `free -g` (the "total"
  column). slm-gate needs 16 GB or more. Under 16 GB, stop: it cannot run on this computer.
- Node.js: `node --version` must print v22 or higher. Missing or older: https://nodejs.org (the LTS download).
- Ollama installed: `ollama --version`. Missing: https://ollama.com/download
- Ollama running: `ollama list` prints a list (it may be empty). If it can't connect: on macOS, open the Ollama
  app; on Linux, see https://docs.ollama.com/linux
- slm-gate installed: `slm-gate --version` prints its version.
  "command not found": install it with `npm install -g @zenithfoundry/slm-gate`. A permission error:
  https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
  "Unknown command": it is an older version; offer `npm update -g @zenithfoundry/slm-gate`.
  If I don't want it installed, use `npx -y @zenithfoundry/slm-gate@1` wherever this prompt says `slm-gate`.
Pause on anything marked ✗, as the RULES say.

STEP 2 — LOOK AROUND
Read only; change nothing yet. Report what you find:
- Settings: does ~/.slm-gate/.env exist? `slm-gate config` shows the settings in effect (keys are hidden).
- Models: `ollama list` (downloaded) and `ollama ps` (loaded in memory now).
- Health: `slm-gate doctor`. Problems are expected before setup; note them.
- Coding tools on this computer: check for the commands claude, codex, gemini, agy, opencode and aider
  (`which <name>`), and the apps Cursor, Claude (desktop) and VS Code (with Cline or Continue). Look in each
  tool's MCP settings (list in STEP 5) for an existing slm-gate entry, and note its command, arguments and env.
- An old git checkout: an slm-gate entry whose command is node, with an argument ending in
  dist/mcp-gate/index.js. Note its folder (the part before /dist). This is a fresh install: nothing is copied
  from that folder.
- A toolbox: DOWNSTREAM_MCP in any slm-gate entry's env, or in the settings file. Also any separate entry for a
  toolbox, such as tech-lead-stack.
Then ask me to confirm or correct the list.

STEP 3 — ASK ME
One question at a time, with your default:
1. How do I use this computer? Run `slm-gate models:check` and offer its two options in plain words:
   OPTION A, mostly for AI (bigger, smarter models); OPTION B, everyday work with a browser and other apps open
   too. Default: B. Mention that https://github.com/AlexsJones/llmfit can pick models that fit even better.
2. Which coding tools should use slm-gate? Default: every tool you found.
3. For each of those tools, how do I pay for its AI? (a) a subscription login (Claude Pro or Max, ChatGPT),
   (b) an API key, or (c) nothing, local models only. For (a) and (b), offer to also send that tool's AI
   requests through slm-gate, which saves more; `slm-gate doctor` lists which tools can. Default: yes, where it
   can.
4. Which paid plan or plans do I have? Valid plans are listed below. Default: skip. This only improves the
   savings figures.
5. Do I use a toolbox (extra tools and skills, such as Tech-Lead-Stack)? If STEP 2 found one, confirm it.
   Default: keep what is there.
6. Tell me, in two sentences, that extras exist and I can ask for any of them now or later: a savings dashboard
   (Langfuse), separate settings for work and personal, a local cache for repeated questions, and running fully
   on this computer. Set up an extra only if I ask for it.

STEP 4 — SHOW THE PLAN
A numbered list of every change: each file, what changes in it, and its backup name; each command you will run
and what it does; each model download and its size (from the RAM table linked below). Wait for my yes.

STEP 5 — SET IT UP
a. Settings file.
   - No settings file yet: for OPTION A, `slm-gate init`. For OPTION B, `slm-gate init --ram <GB>`, where GB is
     this computer's memory minus 8, and at least 16. init never replaces a settings file that exists. With an
     old checkout, do the same: copy nothing from its folder, and never move or delete it.
   - A settings file exists: change only the lines we agreed. For the models, use the chosen option's values
     from the RAM table: RAM_PRESET, SLM_BRAIN_MODEL, SLM_GATE_MODEL, SLM_GATE_TESTING_MODEL and NUM_CTX.
b. Models: download each one with `ollama pull <model>`: the ones init printed, or every model
   `slm-gate doctor` says is missing. Warn me first: this can take a while.
c. Connect each tool. Add an entry named slm-gate with the command slm-gate and the argument mcp (with npx: the
   command npx and the arguments -y, @zenithfoundry/slm-gate@1, mcp). Replace an old checkout's entry in place,
   without its old env values (a toolbox is set up in e). Use the tool's own command if it has one (check `<tool> mcp --help`); otherwise edit
   its settings file, in that file's own format. Where each tool keeps its MCP servers:
   - Claude Code: `claude mcp add --scope user slm-gate -- slm-gate mcp`; with env values,
     `claude mcp add-json --scope user slm-gate '<the entry as JSON>'`
   - Codex: `codex mcp add slm-gate -- slm-gate mcp` (env values go before the --, as --env KEY=VALUE), or
     ~/.codex/config.toml
   - Gemini CLI: `gemini mcp add -s user slm-gate slm-gate mcp` (without -s user it works in one folder only),
     or ~/.gemini/settings.json for env values
   - Antigravity: ~/.gemini/config/mcp_config.json
   - Claude desktop app: ~/Library/Application Support/Claude/claude_desktop_config.json
   - Cursor: ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project)
   - Cline: ask me to click its MCP Servers icon → Configure → Configure MCP Servers; that opens its file.
   - Continue: ~/.continue/config.yaml, a YAML list under mcpServers:
   - OpenCode: ~/.config/opencode/opencode.json, under "mcp", with the command and its argument in one list
     and env values under "environment"
   - Any other tool: find it in the tool's official MCP documentation, and tell me where.
   Each tool's setup page: https://github.com/zenithfoundry/slm-gate/tree/main/configs
   If a file is not where this list says, look it up in the tool's official documentation. Never guess.
d. AI requests, only for the tools I said yes to in STEP 3, question 3. Run `slm-gate doctor` and copy that
   tool's lines from its "Coding tool settings" section exactly. Never write an address from memory. Lines that
   start with export go in my shell's startup file (~/.zshrc on macOS, ~/.bashrc on Linux), after a backup.
   Leave any key blank for me to fill in. Skip the tools doctor lists as unable to.
e. Toolbox, if I have one. In each tool's slm-gate entry, add the env value DOWNSTREAM_MCP: one line of JSON
   saying how to start the toolbox. It is stored as text, so in a JSON file escape its quotes, and in a TOML
   file wrap it in single quotes. Examples:
   - Tech-Lead-Stack from npm: {"command":"npx","args":["-y","tech-lead-stack@1"]}, and TLS_ADAPTER set to on
     in the same env.
   - A toolbox started from a file: {"command":"node","args":["/full/path/to/server.mjs"]}
   - A toolbox already running at a web address: {"url":"http://localhost:PORT/mcp"}
   If the tool also has the toolbox as its own separate entry, ask me whether to remove that entry (after a
   backup): otherwise its tools appear twice. If the toolbox has its own setup command that knows about
   slm-gate, offer to run it now, following the toolbox's own instructions.
f. Plans, if I gave any. One plan: SUBSCRIPTION_PLAN. Plans with more than one company: PLAN_CLAUDE,
   PLAN_CHATGPT and PLAN_GEMINI. Set the matching CLAUDE_WINDOW_BUDGET, CHATGPT_WINDOW_BUDGET or
   GEMINI_WINDOW_BUDGET to the estimate for my plan, from the comments above those lines in the settings file.
   Set PROVIDER to claude, chatgpt or gemini: the company whose AI my tools use most.
g. Run `slm-gate restart`. It starts slm-gate's background service with the new settings and loads both local
   models. If you found an old checkout (<old> being its folder), run `node <old>/dist/cli.js stop; slm-gate restart`
   instead, as one command: the old checkout restarts its own service unless it is stopped with its own command,
   and switching in one go keeps working any tool that sends its AI requests through slm-gate, this one included.

STEP 6 — PROVE IT WORKS
Do all four. Don't say it is finished until each one passes.
1. `slm-gate doctor` ends with READY. If not, fix each ✗ line using the "Fix:" under it, and run it again.
   A "No model request has gone through" note is normal before first use.
2. Wait 30 seconds; then `ollama ps` lists both SLM_BRAIN_MODEL and SLM_GATE_MODEL (`slm-gate config` shows
   their names). If one is missing: check the name matches `ollama list` exactly, run `slm-gate restart`, wait,
   and check again.
3. Ask me to quit each connected tool completely and open it again. If you are running inside one of them, first
   tell me how to come back to this conversation from the same folder: Claude Code `claude --continue`, Codex
   `codex resume --last`, Gemini CLI `gemini --resume latest`; any other tool, check its --help. Then check it
   shows slm-gate as connected:
   Claude Code `claude mcp list`, Codex `codex mcp list`, Gemini CLI `gemini mcp list`, other tools their MCP
   list or panel. With a toolbox, its tools appear under slm-gate. If a desktop app shows slm-gate as failed,
   it probably can't find Node.js: use full paths, as
   https://github.com/zenithfoundry/slm-gate/blob/main/configs/claude-desktop/README.md#slm-gate-shows-as-failed
   explains.
4. For each tool whose AI requests now go through slm-gate: ask me to send it one short message, then run
   `slm-gate doctor` again. The "No model request has gone through" note is gone.

STEP 7 — HAND OVER
Tell me, in a short list:
- Every file you changed, and its backup.
- How to undo each change: copy the backup back; for Claude Code, `claude mcp remove slm-gate`.
- What I still have to do myself (for example, type a key into a file).
- If you found an old checkout: its folder is no longer used, and I can put it in the Trash once everything
  works (dragging it back out undoes that). To bring back its old settings or history first, I follow
  https://github.com/zenithfoundry/slm-gate/blob/main/docs/switch-to-npm.md#optional-bring-back-your-old-settings-and-history
- That the extras are there whenever I ask: the savings dashboard, separate work and personal settings, the
  local cache for repeated questions, and running fully on this computer.

ALLOWED SETTINGS
They go in ~/.slm-gate/.env (for every tool), or in the env of one tool's slm-gate entry (for that tool only;
it wins). The settings file explains each one above its line.
Most people only touch: `SLM_BRAIN_MODEL`, `SLM_GATE_MODEL`, `SLM_GATE_TESTING_MODEL`, `RAM_PRESET`, `NUM_CTX`,
`DOWNSTREAM_MCP`, `TLS_ADAPTER`, `PROVIDER`, `SUBSCRIPTION_PLAN`, `LLM_GATE_PORT`.
Every setting that exists:
- Local models: `SLM_PROVIDER`, `OLLAMA_HOST`, `OLLAMA_KEEP_ALIVE`, `SLM_BRAIN_MODEL`, `SLM_GATE_MODEL`,
  `SLM_GATE_TESTING_MODEL`, `RAM_PRESET`, `NUM_CTX`, `TEMPERATURE`, `SLM_TIMEOUT_MS`, `SELF_CONSISTENCY_K`,
  `SELF_CONSISTENCY_TEMP`, `STRICTNESS_LEVELS`, `HEADLINE_STRICTNESS`, `EMBED_MODEL`, `SEMCACHE`,
  `SEMCACHE_THRESHOLD`.
- Background service (the model gate): `LLM_GATE_PORT`, `LLM_GATE_AUTOSTART`, `LLM_GATE_DISTILL`,
  `LLM_GATE_LOCAL_FIRST`, `LOCAL_ATTEMPT_BUDGET_MS`, `UPSTREAM_ANTHROPIC_URL`, `UPSTREAM_OPENAI_URL`,
  `UPSTREAM_CHATGPT_URL`, `UPSTREAM_GEMINI_URL`.
- Coding tools and toolboxes: `DOWNSTREAM_MCP`, `TLS_ADAPTER`, `MCP_GATE_TRANSPORT`, `MCP_GATE_PORT`.
- Plans and savings figures: `PROVIDER`, `SUBSCRIPTION_PLAN`, `PLAN_CLAUDE`, `PLAN_CHATGPT`, `PLAN_GEMINI`,
  `CLAUDE_WINDOW_BUDGET`, `CHATGPT_WINDOW_BUDGET`, `GEMINI_WINDOW_BUDGET`, `PROVIDER_REGISTRY_PATH`,
  `LEDGER_PATH`.
- Dashboard (an extra): `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`, `LANGFUSE_ENVIRONMENT`,
  `LANGFUSE_RETENTION_DAYS`.
- Hosted AI for hard cases (an extra; it costs money): `CLOUD_API_STYLE`, `CLOUD_BASE_URL`, `CLOUD_API_KEY`,
  `CLOUD_MODEL`, `RESOLVER_CLOUD_TIER`, `RESOLVER_CLOUD_BUDGET_USD`.
- Shrinking tool output: `DISTILL_PRESERVE_PATH`, `DISTILL_PRESERVE_MODE`, `DISTILL_SKILLS`, `DISTILL_ADAPTIVE`,
  `DISTILL_ADAPTIVE_THRESHOLD`, `DISTILL_ADAPTIVE_EXPLORE_RATE`, `DISTILL_FEEDBACK_RETENTION_DAYS`,
  `DISTILL_FEEDBACK_MAX_ROWS`, `DISTILL_MAX_TOKENS`, `DISTILL_MIN_TOKENS`, `DISTILL_BUDGET_MS`,
  `KEEP_RECENT_TOOL_TURNS`, `ELISION_MAX_ENTRIES`, `ELISION_RETENTION_DAYS`, `ELISION_MAX_MB`, `PROMPT_VERSION`.
- Routing: `ROUTING_TUNE`, `ROUTING_TUNE_WINDOW`, `ROUTING_TUNE_MIN_SAMPLES`, `ROUTING_TUNE_THRESHOLD`,
  `ROUTING_TUNE_EXPLORE_RATE`.
- Where the settings file lives (only in a tool's env, for separate sets of settings): `SLM_GATE_HOME`.
Valid values:
- RAM_PRESET: ram-16, ram-24, ram-32, ram-48, ram-64, ram-128, custom (more than 128 GB). The models for each:
  https://github.com/zenithfoundry/slm-gate/blob/main/docs/prerequisites-and-hardware.md#ram-by-machine-model-table
- Plans: claude-pro, claude-max-5x, claude-max-20x, chatgpt-go, chatgpt-plus, chatgpt-pro-5x, chatgpt-pro-20x,
  gemini-plus, gemini-pro, gemini-ultra.
- PROVIDER: claude, chatgpt, gemini. SLM_PROVIDER: ollama, openai. Switches: on or off.

ALLOWED COMMANDS
- `slm-gate --version`, `slm-gate init` (optionally with --ram <GB>), `slm-gate config`, `slm-gate doctor`,
  `slm-gate models:check`, `slm-gate start`, `slm-gate stop`, `slm-gate restart`.
- `slm-gate mcp` is only for a tool's entry. Never run it yourself: it waits silently for a tool to talk to it.
- `slm-gate setup-dashboard`, only when I ask for the dashboard extra.
- `node <old>/dist/cli.js stop; slm-gate restart`, only in STEP 5 g, when you found an old checkout.
- `ollama --version`, `ollama list`, `ollama ps`, `ollama pull <model>`.
- `node --version`, `which node`, `npm root -g`; `npm install -g`, `npm update -g` and `npm view`, for
  @zenithfoundry/slm-gate only.
- `uname -s`, `sysctl -n hw.memsize`, `free -g`, `which <name>`, reading files, and `cp -p` for backups.
- Each coding tool's own MCP commands (such as `claude mcp add`, `list` and `remove`), after checking its --help.
The full guide, if you need more: https://github.com/zenithfoundry/slm-gate/blob/main/docs/install-from-npm.md
```

## Checking the assistant's work

The assistant should prove each of these to you. If it skipped one, ask for it.

1. **`slm-gate doctor` ends with `READY`.**
2. **Both local models are loaded:** `ollama ps` lists the two model names that `slm-gate config` shows for
   `SLM_BRAIN_MODEL` and `SLM_GATE_MODEL`.
3. **Each tool is connected:** after you quit and reopen it, it lists `slm-gate` (and your toolbox's tools, if you
   have one).
4. **Every changed file has a backup** next to it, ending in `.backup-` and the date.
5. **No keys in the chat.** If you pasted one by mistake, make a new key with that company and stop using the old
   one.
6. **No made-up settings:** every name in `~/.slm-gate/.env` appears in the prompt's list above.

## Keep the next assistant on track

The prompt is a one-off conversation. So the next assistant doesn't guess, add this to the instructions file your
assistant reads in every project: `~/.claude/CLAUDE.md` for Claude Code, `~/.codex/AGENTS.md` for Codex,
`~/.gemini/GEMINI.md` for Gemini CLI.

```markdown
## slm-gate

slm-gate is installed on this computer. Its settings are in ~/.slm-gate/.env, or in the env of a coding tool's
slm-gate entry. Check it with `slm-gate doctor`; after changing a setting, run `slm-gate restart`.

- Only use settings that appear in ~/.slm-gate/.env or in
  https://github.com/zenithfoundry/slm-gate/blob/main/docs/agent-setup.md. Never invent one.
- Back up a settings file before changing it. Never run `slm-gate ledger:reset`: it erases the savings history.
```

## Validation record

Each run starts from scratch, with a fresh assistant, on a computer account that has never had `slm-gate`. How the
runs are done and scored: [Testing the AI setup prompt](./agent-setup-validation.md).

**Not validated yet.**

| Date | Assistant | Starting point | Result |
| --- | --- | --- | --- |

If it gets something wrong, that is a bug in this page: please
[open an issue](https://github.com/zenithfoundry/slm-gate/issues) with what it did.
