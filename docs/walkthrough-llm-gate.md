# Walkthrough: Sending Your Coding Tool's Requests Through the Model Gate

> [!NOTE]
> **Is this guide for me?**
> Yes, if your coding tool has a setting for the model's address: Claude Code, Codex, Gemini CLI or `agy` (with a Gemini API key), Cline, Roo Code, Kilo Code, Continue, OpenCode, Zed, Copilot's Custom Endpoint, Junie CLI or Aider.
> You don't need an API key in `slm-gate`: your tool's own login (subscription or API key) is used.
>
> Cursor, Windsurf, the Claude desktop app and Antigravity IDE can't send their requests through a local gate. For them, use Layer 1 (the MCP server) only; see the main README.

### What is the model gate?
The model gate (`llm-gate`) is a small server on your computer at `http://localhost:8787`. Your coding tool sends its model requests there instead of straight to Anthropic, OpenAI or Google. The gate:

1. lets your local model try to answer the **first message** of each conversation (never slash commands, never coding tasks that need the tool's own tools);
2. shrinks large command, search and listing output in **every later request** before it leaves your machine;
3. sends everything it didn't answer to the provider your tool would have used anyway, **with your tool's own login**.

You never start it yourself: `slm-gate`'s MCP server starts it when your coding tool starts.

### What you'll need before starting
- [x] `slm-gate` is built (`pnpm run build`).
- [x] `slm-gate` is added as an MCP server in your coding tool (README, Section 4). This is what starts the model gate.
- [x] Ollama is running and has your models. `node dist/cli.js doctor` checks both and prints the `ollama pull` command for anything missing.

---

## Step 1: Point your coding tool at the gate

Run the doctor from the `slm-gate` folder:

```bash
node dist/cli.js doctor
```

At the end it prints the exact line for each coding tool, with your current port. For **Claude Code**, it is this, in `~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://localhost:8787" } }
```

There is **no `/v1`** at the end. Claude Code adds `/v1/messages` itself; with `/v1` in the setting its requests would go to `/v1/v1/messages` and fail.

*What just happened: you told your tool where to send its model requests. Your login stays the same.*

---

## Step 2: Start your coding tool

Start it as you normally would, for example `claude` in a terminal. When it starts `slm-gate`'s MCP server, the MCP server starts the model gate in the background.

To confirm it is running:

```bash
node dist/cli.js doctor
```

**What you should see:**
```text
✓ Model gate is running on http://localhost:8787 (pid 12345, started 2026-09-19T09:00:00.000Z)
```

If something is wrong (port taken, Ollama not running, a model missing), you also get a desktop notification, and your AI assistant tells you about it with the fix at the start of its next reply.

---

## Step 3: Try it

1. Start a **new conversation** and type `Say hi`. The local model answers; this request never reaches your provider.
2. Now ask for real work, such as "list the files in this folder and tell me what they do". It goes to your provider as normal. When the tool runs commands, their large output is shrunk before the next request leaves your machine.

---

## Step 4: Check the ledger

Every request through the gate is logged in a local file called the **ledger**. From the `slm-gate` folder:

```bash
sqlite3 ./output/ledger.sqlite "SELECT route, api_in_tok FROM events WHERE layer = 'llm' ORDER BY ts DESC LIMIT 5;"
```

**What you should see** (newest first; the number is roughly how many tokens were sent to your provider):
```text
forward_compressed|8200
forward_raw|1450
defer_local|0
```

**How to read this:**
- `defer_local`: answered by your local model. Nothing was sent to your provider (0).
- `forward_compressed`: sent to your provider with some tool output shrunk.
- `forward_raw`: sent to your provider unchanged (nothing large enough to shrink).

`pnpm run slm-gate metrics` shows the totals.

---

## Troubleshooting

- **The tool says it can't connect / connection refused:** the model gate isn't running. Run `node dist/cli.js doctor`; it tells you why and how to fix it. To start it by hand: `node dist/cli.js start`.
- **Port 8787 is used by another program:** quit that program (doctor names it), or set `LLM_GATE_PORT` to a free port in `slm-gate`'s `.env`, run `node dist/cli.js restart`, then paste the new lines doctor prints into each coding tool and restart them.
- **Claude Code gets 404 errors:** remove `/v1` from the end of `ANTHROPIC_BASE_URL`.
- **"slm-gate only accepts requests from programs on this computer" (403):** the address isn't `localhost` or `127.0.0.1`, or the tool runs in a Docker container, a virtual machine or a web page from another site. Only programs on this computer can use the gate.
- **No rows appear in the ledger:** your tool isn't using the gate yet. Check the setting from Step 1, and restart the tool after changing it.
- **"Nothing was answered locally":** only the first message of a conversation is tried, and only when it's something a small model can answer. Slash commands and coding tasks always go to your provider. Check that Ollama is running (`node dist/cli.js doctor`).
