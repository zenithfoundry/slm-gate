# Step-by-Step Setup Walkthrough

Follow these steps in order. By the end, `slm-gate` will be running and wired up to your editor. Then head to the [Configuration Setup Guide](configuration.md) to fine-tune your settings.

---

## Step 1 — Clone the Repository

Open a terminal and run:

```bash
git clone https://github.com/zenithfoundry/slm-gate.git small-language-model-gate
cd small-language-model-gate
```

This downloads `slm-gate` into a folder called `small-language-model-gate` in your current directory.

---

## Step 2 — Install Dependencies & Build

```bash
pnpm install
pnpm run build
```

`pnpm install` downloads all the code libraries `slm-gate` needs. `pnpm run build` compiles the TypeScript source into runnable JavaScript files in the `dist/` folder. You should see no errors.

> _If you later modify any `.ts` source files, run `pnpm run build` again to pick up changes._

**The `slm-gate` command.** These docs write commands as `slm-gate doctor`, `slm-gate restart` and so on. To have that short command everywhere, run `pnpm link --global` in this folder once (it needs `pnpm setup` to have been run once on your machine). Without it, use `node dist/cli.js doctor` from this folder. `slm-gate`'s own warnings always print the full command, e.g. `node /Users/yourname/projects/small-language-model-gate/dist/cli.js restart`, so they work either way.

---

## Step 3 — Start Ollama & Download Local Models

Make sure Ollama is running. How you start it depends on how you installed it:

```bash
# Installed with Homebrew (it then runs in the background from login)
brew services start ollama

# Installed as the macOS app — look for the llama icon in your menu bar
open -a Ollama

# Installed as a plain binary, or on Linux without a systemd unit
ollama serve

# Linux, installed with the official script (systemd)
sudo systemctl start ollama
```

If `ollama serve` prints `address already in use`, **Ollama is already running** — Homebrew or systemd started it for you. That is not an error to fix. Check with `ollama ps`, or `curl http://localhost:11434/api/tags`.

`slm-gate` works out which of these applies to your machine and names the right command in any notification it shows you.

Then download the models for your machine. For a **16 GB machine** (the recommended starting point):

```bash
ollama pull qwen2.5-coder:3b    # Brain model: smarter, used for compression & local resolution
ollama pull qwen2.5-coder:0.5b  # Gate model: tiny, used for quick routing decisions
```

Check the [RAM table](prerequisites-and-hardware.md#ram-by-machine-model-table) to find the right models for your machine's memory.

> _Not sure what to pick? Run `npm run models:check` after pulling a model and it will recommend the best pair for your hardware._

---

## Step 4 — Wire Up Your Editor / Client

Find your editor below and follow those steps. Each client config uses an **absolute path** to the built `slm-gate` file — replace `<ABS_PATH>` with the full path to where you cloned the repo.

To find your absolute path, run this in your terminal from inside the `small-language-model-gate` folder:

```bash
pwd
# Example output: /Users/yourname/projects/small-language-model-gate
```

Your built MCP entry point will be at: `/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js`

---

### Google Antigravity (Antigravity IDE, Antigravity 2, `agy` CLI)

Antigravity reads its MCP server list from a global configuration file. You add `slm-gate` there.

**File to edit:** `~/.gemini/config/mcp_config.json`

If the file doesn't exist yet, create it. Add (or merge) the following into the `mcpServers` block:

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": [
        "/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"
      ],
      "env": {
        "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
        "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
        "NUM_CTX": "4096",
        "OLLAMA_MAX_LOADED_MODELS": "2"
      }
    }
  }
}
```

> **Important:** For Antigravity, values in this JSON `"env"` block override `slm-gate`'s `.env` for the MCP server inside Antigravity. The model gate reads only `slm-gate`'s `.env`, so copy the preset for your RAM from `configs/antigravity/` to `.env` too, and keep the model settings the same in both places.

**Using Tech-Lead-Stack as your downstream?** Add these two extra keys to the `env` block:
```json
"TLS_ADAPTER": "on",
"DOWNSTREAM_MCP": "{\"command\":\"node\",\"args\":[\"/abs/path/to/tech-lead-stack/dist/mcp-server.mjs\"]}"
```

After saving, reload MCP servers in Antigravity (usually via the Settings → MCP panel or a restart).

See the full config reference: [`configs/antigravity/README.md`](../configs/antigravity/README.md)

---

### Claude (Claude Code & Claude Desktop)

**Claude Code** (the `claude` terminal app):

The easiest way to add `slm-gate` to Claude Code is the CLI one-liner:

```bash
claude mcp add-json slm-gate '{
  "command": "node",
  "args": ["/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"],
  "env": {
    "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
    "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
    "NUM_CTX": "4096"
  }
}'
```

Alternatively, create or edit `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": ["/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"],
      "env": {
        "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
        "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
        "NUM_CTX": "4096"
      }
    }
  }
}
```

**Layer 2 (optional — send Claude Code's model requests through `llm-gate`):** add the address to `~/.claude/settings.json`. Note there is **no `/v1`** at the end; Claude Code adds it itself.
```json
{ "env": { "ANTHROPIC_BASE_URL": "http://localhost:8787" } }
```
In the VS Code extension, set it in your VS Code user settings instead:
```json
"claudeCode.environmentVariables": [{ "name": "ANTHROPIC_BASE_URL", "value": "http://localhost:8787" }]
```
Your claude.ai login or API key keeps working. The model gate starts by itself the next time Claude Code starts `slm-gate`'s MCP server.

> _Note: behind any address other than Anthropic's, Claude Code stops using server-side MCP tool search (set `ENABLE_TOOL_SEARCH=true` to turn it back on), and Remote Control and server-managed settings are not available. The Claude desktop app's Code tab ignores this setting._

See the full config reference: [`configs/claude-code/README.md`](../configs/claude-code/README.md)

---

**Claude Desktop** (the Anthropic desktop app):

**File to edit:**
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": ["/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"],
      "env": {
        "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
        "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
        "NUM_CTX": "4096"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

> **Claude Desktop starts MCP servers from a working directory that does not exist.** Leave `LEDGER_PATH` blank in your `.env`, or set it to the full path on your machine. A relative path such as `./output/ledger.sqlite` makes the server fail on startup with `ENOENT: mkdir './output'`. See [Ledger Path Must Be a Full Path on Your Machine](configuration.md#ledger-path-must-be-a-full-path-on-your-machine).

See the full config reference: [`configs/claude-desktop/README.md`](../configs/claude-desktop/README.md)

---

### Cursor

Create or edit the file `.cursor/mcp.json` in your project workspace root:

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": ["/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"],
      "env": {
        "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
        "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
        "NUM_CTX": "4096"
      }
    }
  }
}
```

**Layer 2 is not possible in Cursor.** Cursor sends every model request through its own servers first, even with "Override OpenAI Base URL" set, and those servers can't reach `localhost`. Layer 1 works as above.

See the full config reference: [`configs/cursor/README.md`](../configs/cursor/README.md)

---

### VS Code Extensions: Cline & Continue

Both Cline and Continue are AI coding extensions for VS Code and JetBrains that support custom MCP servers and full provider flexibility.

**Cline** — edit `cline_mcp.json` (usually at `~/.cline/cline_mcp.json` or in your project root):

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": ["/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"],
      "env": {
        "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
        "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
        "NUM_CTX": "4096"
      }
    }
  }
}
```

**Continue** — edit `.continue/config.yaml` in your project root or home directory:

```yaml
mcpServers:
  - name: slm-gate
    command: node
    args:
      - /Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js
    env:
      SLM_BRAIN_MODEL: "qwen2.5-coder:3b"
      SLM_GATE_MODEL: "qwen2.5-coder:0.5b"
      NUM_CTX: "4096"
```

**Layer 2 (optional — send their model requests through `llm-gate`, with your own API key):**
- **Cline / Roo Code:** Settings → API Provider **Anthropic** → tick **Use custom base URL** → `http://localhost:8787`.
- **Continue:** in `config.yaml`, on the model: `provider: anthropic` and `apiBase: http://localhost:8787/v1/` (for OpenAI models: `provider: openai`, `apiBase: http://localhost:8787/v1`).

Models bundled with Cline's or Continue's own subscription can't be redirected. `slm-gate doctor` prints these lines with your current port.

See the full config reference: [`configs/cline-continue-opencode/README.md`](../configs/cline-continue-opencode/README.md)

---

### Codex, Gemini CLI & Other Tools (Layer 2)

Add `slm-gate` as an MCP server in the tool (see its MCP documentation; the JSON is the same as above), so the model gate starts with the tool. Then point the tool's model address at the gate:

**Codex** (CLI and IDE extension share `~/.codex/config.toml`). Your ChatGPT login or API key keeps working:
```toml
model_provider = "slm-gate"

[model_providers.slm-gate]
name = "slm-gate"
base_url = "http://localhost:8787/v1"
requires_openai_auth = true
```
Don't set `supports_websockets`: over a WebSocket Codex sends only the newest part of the conversation, so the gate can't see or shrink the rest.

**Gemini CLI** (API key only; a Google-account login ignores the address setting):
```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:8787
export GEMINI_API_KEY=<your key>
```
and in `~/.gemini/settings.json`: `{ "security": { "auth": { "selectedType": "gemini-api-key" } } }`. For the Antigravity CLI (`agy`), set the same two variables and `{ "modelProvider": "gemini" }` in `~/.gemini/antigravity-cli/settings.json`.

**OpenCode, Kilo Code, Zed, Copilot Custom Endpoint, Junie CLI, Aider:** run `slm-gate doctor`. It prints the exact setting for each tool with your current port. Copy it from there rather than guessing: each tool wants the address in a slightly different form (with or without `/v1`, or the full `/v1/messages` path).

---

## ✅ You're Set Up! What's Next?

With your editor wired up, proceed to the **[Configuration Setup Guide](configuration.md)** to create your `.env` file with the right settings for your machine — starting from the 16 GB preset.

---

[README](../README.md) · [All docs](README.md) · Next: [Configuration Setup Guide](configuration.md)
