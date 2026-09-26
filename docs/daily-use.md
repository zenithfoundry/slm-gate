# Verification & Day-to-Day Use

## Run the Preflight Health Check

Before using `slm-gate` in anger, confirm everything is wired up correctly:

```bash
pnpm run dev doctor
# or: node dist/cli.js doctor
```

This checks:
- Node.js version
- Ollama is running, and every model your settings name is downloaded (each missing one with its `ollama pull` command)
- Your hardware and `NUM_CTX` fit the models
- Layer 1 config is valid
- **The model gate is running.** If it isn't, it says so loudly (every coding tool pointed at it can't reach its AI provider), names the program holding the port if there is one, and gives the fix

It then prints the exact line to paste into each coding tool, using your current port, and lists the tools that can't use Layer 2 and why.

Fix any warnings it flags before proceeding.

## The Model Gate: Starts by Itself, and What to Do When It Can't

You don't need to run anything each day. The first coding tool you open starts `slm-gate`'s MCP server, which starts the model gate and checks Ollama and your models. If something is wrong you get a desktop notification, and your AI assistant tells you at the start of its next reply.

What your assistant tells you is a **snapshot from when `slm-gate` started**, because an MCP server's instructions are fixed for the whole session and cannot be rewritten later. If you fix the problem mid-session, the assistant may still repeat it — it is told so, and told to believe you over the notice. The desktop notifications and `slm-gate doctor` are always live. A problem that might just be a slow moment is never reported until a second check, a minute later, finds it still there.

| What you see | What to do |
| :--- | :--- |
| **Port 8787 is used by another program** | Quit that program (`slm-gate doctor` names it), then run `slm-gate start`. Or move the gate: set `LLM_GATE_PORT` to a free port in `slm-gate`'s `.env`, run `slm-gate restart`, then run `slm-gate doctor` and paste the new lines into each coding tool. |
| **The model gate is not running and did not start** | Run `slm-gate start`. If it still fails, read `output/llm-gate.log` in the `slm-gate` folder. After updating `slm-gate`, or if the log shows a missing file, repair the install with `pnpm install && pnpm run build` in the `slm-gate` folder, then `slm-gate restart`. |
| **The model gate is running an older build** | Run `slm-gate restart` when no coding tool is in the middle of an answer. |
| **Ollama is not running** | Run the command the notification names — `slm-gate` picks it from how Ollama is installed here (`brew services start ollama`, `open -a Ollama`, `sudo systemctl start ollama` or `ollama serve`). Requests still reach the cloud meanwhile; nothing is answered or shrunk locally. |
| **Ollama did not answer** | Usually nothing. `slm-gate` gave up waiting rather than finding Ollama down, which mostly happens while everything is still starting. It only tells you at all if it is still true a minute later. If it keeps happening, run `slm-gate doctor`. |
| **`OLLAMA_HOST` is not an http address** | Set `OLLAMA_HOST` to a full URL, e.g. `http://localhost:11434`. Ollama's *own* `OLLAMA_HOST` variable is a bare `host:port`, so a value copied from Ollama's docs will not work here. |
| **Something is listening but it is not Ollama** | Another program holds port 11434, or `OLLAMA_HOST` points somewhere else. `slm-gate doctor` names what holds the port. |
| **A local model is not downloaded** | Run the `ollama pull …` command shown. |
| **MCP servers left over from closed coding tools** | Run the `kill …` command `slm-gate doctor` prints. These are servers started by a build from before `slm-gate` learned to stop itself; a force-quit editor left them behind, and each keeps checking Ollama and showing notifications from that old build. Current builds stop themselves, so this clears once and does not come back. |

`slm-gate stop` stops the model gate and keeps it stopped until `slm-gate start`, `slm-gate restart` or your next restart; coding tools pointed at it can't reach their provider meanwhile. `slm-gate serve` runs the model gate in the terminal instead (useful for watching its log).

## Checking a Coding Tool Through the Gate (Run Later)

`slm-gate` ships a live check for each coding tool. Each check makes the tool read `package.json` through the gate and reply with its name, which proves a full back-and-forth including a tool step. Run them whenever you install a tool or get an account:

```bash
pnpm exec tsx scripts/spike-check.ts --list                          # every check and its id
pnpm exec tsx scripts/spike-check.ts codex-chatgpt-login --gate      # one check, through the real model gate
pnpm exec tsx scripts/spike-check.ts --manual --gate                 # the IDE extensions: you send the prompt, it checks the result
```

- `--gate` runs the check through a separate, temporary model gate (its own port and throwaway ledger), so your running gate and your ledger are not touched.
- A check shows **SKIPPED**, not failed, when the tool isn't installed or the key it needs isn't set.
- **Codex with a ChatGPT login** (`codex-chatgpt-login`) matters most: how the gate recognises that login was worked out from Codex's source code and has never been run against a real ChatGPT login.

## Check Your Savings (Any Time)

```bash
pnpm run slm-gate metrics
```

Prints a live summary from your local ledger: tokens saved, compression ratio, local vs. cloud routing split, and subscription runway reclaimed. No internet required.

## The Metrics Dashboard

For a visual view, `slm-gate` ships a one-page dashboard that reads the same local ledger — no cloud, no account, no extra dependencies:

```bash
pnpm run dashboard            # opens at http://localhost:8790, local-only, read-only
```

It shows the numbers that justify running the gate: **how many minutes of each provider's rolling usage window you got back per cycle** (a cycle is the 5-hour window your first Claude request opens), tokens saved per provider, week-by-week charts, the routing decision split, and SLM accuracy — with benchmark runs kept separate from real traffic, and anything unmeasured shown as "not measured", never a fake zero.

**Publish yours for free on GitHub Pages:**

```bash
pnpm run dashboard:export     # bakes a static site/ folder — aggregate numbers only
```

Commit `site/` and push; the included Pages workflow deploys it (one-time setup: repo **Settings → Pages → Source: GitHub Actions**). The export contains only counts, token sums, minutes and dates — never prompts, tool names or skill names. And with no hosting at all, anyone can open a hosted copy of the page and drag their own `data.json` onto it: it renders in the browser and uploads nothing. Details in [analytics-and-observability.md](analytics-and-observability.md).

The published page is a snapshot and does not refresh itself: re-export and push, or schedule `scripts/dashboard-publish.sh` to do it daily at no cost — see [Keeping the published dashboard current](analytics-and-observability.md#keeping-the-published-dashboard-current).

## Verify Active Compression in Your Editor

When your editor calls a tool (like `get_skill` in Tech-Lead-Stack), the response that arrives in your editor's context should be noticeably shorter than the raw output — but still contain all the critical content (headings marked `MUST`, YAML frontmatter, phase markers).

To see `slm-gate` working in real-time, check your editor's MCP logs for the string `[pipeline] distill`:

| Editor | How to View MCP Logs |
| :--- | :--- |
| **Antigravity** | Antigravity output/MCP tab |
| **Cursor** | Output panel → select "MCP" from dropdown |
| **Claude Desktop (macOS)** | `tail -f ~/Library/Logs/Claude/mcp*.log` |
| **Claude Desktop (Windows)** | `type "%APPDATA%\Claude\logs\mcp*.log"` |
| **Cline / VS Code** | VS Code Output panel → select "Cline" or your MCP server |
| **Claude Code** | Start with `--mcp-debug` flag for detailed terminal output |

## Cloud API Keys

Neither layer needs a `CLOUD_API_KEY`: the model gate sends each request on with your coding tool's own login. The `CLOUD_*` variables are only required if:
- You run the offline testing harness (`slm-gate bench`), or
- You turn on the resolver's cloud tier (`RESOLVER_CLOUD_TIER`), or use `SLM_PROVIDER=openai`

---

[README](../README.md) · [All docs](README.md) · Next: [Architecture & Advanced Features](advanced.md)
