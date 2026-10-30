# Daily use

The health check, what to do when something does not start, the commands you may need, and what the gate remembers.

You rarely start anything by hand. The first coding tool you open starts `slm-gate`'s MCP gate, which starts the
model gate in the background and checks Ollama and your models. If something is wrong you get a desktop
notification, and your AI assistant tells you at the start of its next reply.

## The health check

```bash
slm-gate doctor
```

It checks Node.js, that Ollama is running and every model your settings name is downloaded (each missing one with
its `ollama pull` command), that your hardware and `NUM_CTX` fit the models, that the settings file is valid, and
**that the model gate is running**. If the gate is not running it says so loudly, names the program holding the
port if there is one, and gives the fix. It then prints the line each coding tool needs to send its AI requests
through the gate, and ends with `READY` when all is well.

## When something does not start

What your assistant tells you is a **snapshot from when `slm-gate` started**: an MCP server's instructions are
fixed for the whole session. If you fix the problem mid-session, the assistant may still repeat it. The desktop
notifications and `slm-gate doctor` are always live. A problem that might just be a slow moment is never reported
until a second check, a minute later, finds it still there.

| What you see | What to do |
| :--- | :--- |
| **Port 8787 is used by another program** | Quit that program (`slm-gate doctor` names it), then `slm-gate start`. Or move the gate: set `LLM_GATE_PORT` to a free port in `~/.slm-gate/.env`, run `slm-gate restart`, then `slm-gate doctor` and paste the new lines into each coding tool. |
| **The model gate is not running and did not start** | Run `slm-gate start`. If it still fails, read `~/.slm-gate/output/llm-gate.log`. After an upgrade, `slm-gate restart`. |
| **The model gate is running an older build** | Run `slm-gate restart` when no coding tool is in the middle of an answer. |
| **Ollama is not running** | Run the command the notification names; `slm-gate` picks it from how Ollama is installed (`brew services start ollama`, `open -a Ollama`, `sudo systemctl start ollama` or `ollama serve`). Requests still reach your provider meanwhile; nothing is shrunk. |
| **Ollama did not answer** | Usually nothing. `slm-gate` gave up waiting rather than finding Ollama down, which mostly happens while everything is still starting. If it keeps happening, run `slm-gate doctor`. |
| **`OLLAMA_HOST` is not an http address** | Set `OLLAMA_HOST` to a full URL, such as `http://localhost:11434`. Ollama's own `OLLAMA_HOST` variable is a bare `host:port`, so a value copied from Ollama's docs does not work here. |
| **Something is listening but it is not Ollama** | Another program holds port 11434, or `OLLAMA_HOST` points somewhere else. `slm-gate doctor` names what holds the port. |
| **slm-gate has no settings file** | The model gate reads only `~/.slm-gate/.env` ([why](install.md#where-settings-come-from)). Without it, built-in default models are used. Run `slm-gate init`, the `ollama pull` line it prints, then `slm-gate restart`. With npx: `npx -y @zenithfoundry/slm-gate@1 init` and `restart`. |
| **A local model is not downloaded** | Run the `ollama pull` command shown. If the message says *in slm-gate's .env*, the model is named in the settings file. Download it, or change `SLM_GATE_MODEL` or `SLM_BRAIN_MODEL` there to a model you have, then `slm-gate restart`. Changing a coding tool's `env` block does not change the gate. |
| **MCP servers left over from closed coding tools** | Run the `kill` command `slm-gate doctor` prints. A force-quit editor left servers from an older build behind. Current builds stop themselves, so this clears once. |
| **A tool says it cannot connect (connection refused)** | The model gate is not running. `slm-gate doctor` says why; `slm-gate start` starts it. |
| **Claude Code gets 404 errors** | Remove `/v1` from the end of `ANTHROPIC_BASE_URL`; Claude Code adds it itself. |
| **"slm-gate only accepts requests from programs on this computer" (403)** | The address is not `localhost` or `127.0.0.1`, or the tool runs in a Docker container, a virtual machine or a web page from another site. |

## Commands you may need

| Command | Does |
| :--- | :--- |
| `slm-gate doctor` | The health check above |
| `slm-gate config` | Prints every setting in effect (keys hidden) |
| `slm-gate start`, `stop`, `restart` | Starts or stops the background model gate. `stop` lasts until `start`, `restart` or a reboot; coding tools pointed at the gate cannot reach their provider meanwhile. Run `restart` after changing a setting or upgrading. |
| `slm-gate serve` | Runs the model gate in this terminal instead, to watch its log |
| `slm-gate memory` | What the gate remembers of each conversation (below) |
| `slm-gate metrics` | Rows, tokens and cost in the ledger ([Measure your savings](measure-savings.md)) |
| `slm-gate models:check` | Checks your models are downloaded and fit in memory |
| `slm-gate ledger:sync` | Sends ledger history to Langfuse |
| `slm-gate setup-dashboard` | Builds the Langfuse dashboard |
| `slm-gate ledger:reset --yes` | Deletes the ledger named by `LEDGER_PATH` (every request and saving recorded). There is no undo, so `--yes` is required. |

`slm-gate help` lists them all.

## Check it is working

When your coding tool calls a tool (such as `get_skill` in Tech-Lead-Stack), the result that reaches it should be
noticeably shorter than the raw output, but still hold every heading marked `MUST`, the YAML frontmatter and the
phase markers. To see the gate at work, look for `[pipeline] distill` in your tool's MCP logs:

| Tool | Where the MCP logs are |
| :--- | :--- |
| **Antigravity** | the output/MCP tab |
| **Cursor** | Output panel, "MCP" in the dropdown |
| **Claude Desktop** | `tail -f ~/Library/Logs/Claude/mcp*.log` |
| **Cline / VS Code** | Output panel, "Cline" or your MCP server |
| **Claude Code** | start it with `--mcp-debug` |

For model requests, `slm-gate doctor` notes when no request has gone through the gate recently.

## What the gate remembers of a conversation

The model gate keeps a short memory of each conversation it forwards: the goal, what was decided, and the files,
commands and names that keep coming up. The brain model folds the newest turns into it only while the gate is
idle, so it never slows a request. See it any time:

```bash
slm-gate memory
```

Who reads it: `ask_elision`, so "which step are we on?" has a context, and the open-decisions step, which stops
asking questions the conversation already settled. The MCP gate cannot know which conversation a tool call
belongs to, so it takes the newest memory for the same workspace from a conversation that began after the
session did, within ten minutes; two sessions in the same repository at once can cross. The summary stays in the
ledger on this computer: it is never sent to Langfuse or printed in logs. Settings: [Conversation
memory](../reference/settings.md#conversation-memory).

## Decision memory: answer a question once per repository

The gate finds [open decisions](../README.md#glossary) in a skill ("API-first or UI-first?") and tries to answer
them from your repository. Write the answer down once and it is never asked again in that repository:

```text
.slm-gate/decisions/architecture-direction.md
```
```markdown
---
type: Decision
title: Architecture direction
verified_by: human:<your name>
verified_at: 2026-10-21
stale_after: 2027-04-01
---
API-first. The primary product boundary is the MCP protocol and the wire formats.
```

The question is matched against the titles and bodies of your decision files (full-text search in the ledger, no
embeddings), the brain model confirms the decision really answers it, and the answer goes through the same risk
gate as every answer read from your code: a security or destructive question is never auto-applied from a file.
A file with a `human:` `verified_by` line that is not past `stale_after` is applied, with the file name and who
verified it printed next to the answer; any other file is only offered as a recommendation. Editing a decision
file makes the next run recompute instead of using its cache. Commit the folder with the repository.

## Learned protections: a lost sentence is never lost twice

With `DISTILL_SKILLS=on` (the proven and toolbox [profiles](profiles.md)), whenever the brain model reports that a
shortened paragraph dropped a requirement sentence, that paragraph goes out word for word and the sentence is
stored in the ledger. From then on any line of any skill that contains that sentence is protected by code before
a model sees anything. The dashboard's **Skill fidelity** card shows the count. Your own patterns in
`DISTILL_PRESERVE_PATH` still apply.

## If the local models keep unloading

`slm-gate` needs its two models loaded together. Ollama's slot count (`OLLAMA_MAX_LOADED_MODELS`) should be 2,
exactly the pair ([Hardware](../reference/hardware.md#keep-both-models-loaded)). When anything loads a third
model, one of the pair is evicted and the next call pays a reload. The usual cause is `ollama run
some-other-model`. With `SLM_PIN_MODELS=on` (the default) the model gate checks every minute and, only when one
of its models is missing, unloads the stranger and warms its own model back in. To see what is loaded, use
`ollama ps`, never `ollama run`.

## Cloud API keys

Neither gate needs a `CLOUD_API_KEY`: the model gate sends each request on with your coding tool's own login.
The `CLOUD_*` settings are read only by the open-decisions step's optional cloud tier (`RESOLVER_CLOUD_TIER`)
and by `SLM_PROVIDER=openai` ([Settings](../reference/settings.md#the-resolvers-api-model)).

---

Next: [Measure your savings](measure-savings.md)
