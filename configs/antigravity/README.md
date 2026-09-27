# Antigravity MCP Configuration

**File Location:** `~/.gemini/config/mcp_config.json` (all workspaces) or `.agents/mcp_config.json` in a workspace's
folder. In the IDE: agent side panel → MCP Servers → Manage MCP Servers → View raw config.

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "slm-gate",
      "args": ["mcp"]
    }
  }
}
```

- **Without installing it:** `"command": "npx", "args": ["-y", "@zenithfoundry/slm-gate@1", "mcp"]`.
- **From a git checkout:** `"command": "node", "args": ["/full/path/to/small-language-model-gate/dist/mcp-gate/index.js"]`.
- **A toolbox behind `slm-gate` (optional):** add an `env` block to the entry, as in
  [Connect a toolbox](../../docs/install-from-npm.md#connect-a-toolbox-optional).
- **By web address** (`slm-gate serve --layer mcp --transport http`): Antigravity needs `serverUrl`, not `url`.

Then restart Antigravity and check with `slm-gate doctor`.

> **Where settings go:** in `slm-gate`'s own settings file (`~/.slm-gate/.env`, made by `slm-gate init`), for every
> tool. A value in this entry's `env` block changes it for Antigravity's MCP server only, and wins over the file.
> The model gate (Layer 2), shared by all your coding tools, reads only the settings file. The MCP server checks
> that the models named in both places are downloaded.

## Model gate (Layer 2)

- **Antigravity IDE / Antigravity 2:** not possible. There is no setting for the model's address. Use the MCP server above (Layer 1).
- **Antigravity CLI (`agy`), with a Gemini API key only:** set `{ "modelProvider": "gemini" }` in `~/.gemini/antigravity-cli/settings.json`, then
  ```bash
  export GOOGLE_GEMINI_BASE_URL=http://localhost:8787
  export GEMINI_API_KEY=<your key>
  ```
  A Google-account login ignores the address setting, and Google's terms say using that login through other tools may get the account suspended.
- Changed `LLM_GATE_PORT`? `slm-gate doctor` prints these lines with the new port.

---

### 🍏 Best Practices for macOS/Homebrew Users

When deploying Ollama on macOS via Homebrew (`brew install ollama`), developers face a severe configuration trap.

> [!WARNING]
> **The Configuration Trap:** Running `brew services restart ollama` aggressively overwrites the `~/Library/LaunchAgents/homebrew.mxcl.ollama.plist` file. This silently deletes any custom `EnvironmentVariables` you have manually added, resulting in aggressive model swapping and context truncation. Furthermore, Homebrew's native `.env` injection (via `~/.config/homebrew/services/`) is frequently ignored by the macOS LaunchDaemon for the Ollama formula.

**The Solution:**
To persistently apply critical environment variables for high-performance SLM routing without them being overwritten by Homebrew:
1. Stop the brew service: `brew services stop ollama`
2. Manually add your `EnvironmentVariables` dictionary to `~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`.
3. Natively load the daemon: `launchctl load ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`

**Required Variables for this Repo:**
- `OLLAMA_CONTEXT_LENGTH="8192"` (Ensures Ollama's global context matches the app's `NUM_CTX`)
- `OLLAMA_KEEP_ALIVE="12h"` (Prevents unloaded models, ensuring warm latency)
- `OLLAMA_MAX_LOADED_MODELS="2"` (or `1`, depending on VRAM capacity to prevent model swapping)

*For further reading, refer to the [official Ollama FAQ on memory and concurrency](https://docs.ollama.com/faq).*

### ⚠️ RAM Sizing & Troubleshooting Disclaimer: If Your RAM Config Is Not Working

If your models are getting evicted, Ollama is thrashing/swapping back and forth between disk and memory, or your Mac is experiencing high memory pressure, the following **MUST** be considered:

#### The Memory Formula
```text
Memory = Model Weights + (NUM_CTX × KV-Cache) × Models Loaded
```

**Dropping the brain model to a 7B is exactly the right lever, and yes it'll cut RAM. But don't just hand-edit `NUM_CTX` to a smaller number and call it done — memory is model weights + (`NUM_CTX` × KV-cache) × models loaded.**

While this example shows dropping from a 9B (or 14B) to a 7B model, this principle is a general rule that applies to all RAM capacities:

1. **Check your pulled tags:**
   ```bash
   ollama list        # see which qwen tags are pulled
   ```
2. **Pick a smaller brain:**
   e.g. `qwen2.5:7b` (pull it if needed: `ollama pull qwen2.5:7b`).
   Keep the small gate model (`qwen2.5-coder:3b`) as-is; it's already tiny (~2GB).
3. **Set it in `slm-gate`'s settings file** (`~/.slm-gate/.env`), which the model gate reads:
   ```bash
   SLM_BRAIN_MODEL=qwen2.5:7b
   SLM_GATE_MODEL=qwen2.5-coder:3b
   NUM_CTX=4096
   ```
   If your Antigravity `slm-gate` entry also sets these in its `env` block, change them there too: that block wins
   for Antigravity's MCP server.
4. **Shrink `NUM_CTX`:**
   Lowering `NUM_CTX` from `8192` → `4096` is where a lot of the RAM savings actually comes from (the KV cache shrinks with it), and it's the single biggest knob after model size.
5. **Fallback to Single-Model Mode if still heavy:**
   If memory is still heavy, set `OLLAMA_MAX_LOADED_MODELS=1` for Ollama itself, as in the Homebrew section above
   (it is Ollama's setting: `slm-gate` does not read it). This forces one model in memory at a time (slower
   switching between gate and brain, but drastically reduces RAM usage).
6. **Use doctor to sanity-check** the fit for your RAM:
   ```bash
   slm-gate doctor   # in a git checkout: node dist/cli.js doctor
   ```

After changing settings, run `slm-gate restart` (the model gate reads its settings when it starts), restart/refresh
MCP servers in Antigravity, and verify with `slm-gate doctor`.
