# Antigravity MCP Configuration

First: `npm install -g @zenithfoundry/slm-gate`, then `slm-gate init --profile starter` (or `proven` or `toolbox`,
see [Profiles](../../docs/npm/profiles.md)), the `ollama pull` line it prints, and `slm-gate doctor`
([Install](../../docs/npm/install.md)). Then add the entry below.

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
  [Connect a toolbox](../../docs/npm/install.md#connect-a-toolbox).
- **By web address** (`slm-gate serve --layer mcp --transport http`): Antigravity needs `serverUrl`, not `url`.

Then restart Antigravity and check with `slm-gate doctor`.

> **Where settings go:** in `slm-gate`'s own settings file (`~/.slm-gate/.env`, made by `slm-gate init`), for every
> tool. A value in this entry's `env` block changes it for Antigravity's MCP server only, and wins over the file.
> The model gate, shared by all your coding tools, reads only the settings file. The MCP gate checks that the
> models named in both places are downloaded.

## Model gate

- **Antigravity IDE / Antigravity 2:** not possible. There is no setting for the model's address. Use the MCP gate above.
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
To keep the environment variables the two local models need, without Homebrew overwriting them:
1. Stop the brew service: `brew services stop ollama`
2. Manually add your `EnvironmentVariables` dictionary to `~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`.
3. Natively load the daemon: `launchctl load ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`

**Required Variables for this Repo:**
- `OLLAMA_CONTEXT_LENGTH="8192"` (Ensures Ollama's global context matches the app's `NUM_CTX`)
- `OLLAMA_KEEP_ALIVE="12h"` (Prevents unloaded models, ensuring warm latency)
- `OLLAMA_MAX_LOADED_MODELS="2"` (exactly the pair; `slm-gate` keeps both loaded with `SLM_PIN_MODELS=on`)

*More in [Hardware](../../docs/reference/hardware.md#keep-both-models-loaded) and the [official Ollama FAQ](https://docs.ollama.com/faq).*

### ⚠️ RAM Sizing & Troubleshooting Disclaimer: If Your RAM Config Is Not Working

If your models are getting evicted, Ollama is thrashing/swapping back and forth between disk and memory, or your Mac is experiencing high memory pressure, the following **MUST** be considered:

#### The Memory Formula
```text
Memory = Model Weights + (NUM_CTX × KV-Cache) × Models Loaded
```

**Dropping the brain model to a 7B is exactly the right lever, and yes it'll cut RAM. But don't just hand-edit `NUM_CTX` to a smaller number and call it done: memory is model weights + (`NUM_CTX` × KV-cache) × models loaded.**

While this example shows dropping from a 9B (or 14B) to a 7B model, this principle is a general rule that applies to all RAM capacities:

1. **Check your pulled tags:**
   ```bash
   ollama list        # see which qwen tags are pulled
   ```
2. **Pick a smaller brain:**
   e.g. `qwen2.5:7b` (pull it if needed: `ollama pull qwen2.5:7b`).
   Keep the small gate model (`qwen3.5:2b`) as-is; it's already tiny (~2GB).
3. **Set it in `slm-gate`'s settings file** (`~/.slm-gate/.env`), which the model gate reads:
   ```bash
   SLM_BRAIN_MODEL=qwen2.5:7b
   SLM_GATE_MODEL=qwen3.5:2b
   NUM_CTX=4096
   ```
   If your Antigravity `slm-gate` entry also sets these in its `env` block, change them there too: that block wins
   for Antigravity's MCP server.
4. **Shrink `NUM_CTX`:**
   Lowering `NUM_CTX` from `8192` → `4096` is where a lot of the RAM savings actually comes from (the KV cache shrinks with it), and it's the single biggest knob after model size.
5. **Keep two Ollama slots.** Do not drop `OLLAMA_MAX_LOADED_MODELS` to `1` while `SLM_PIN_MODELS=on`: the
   gate would keep reloading its missing model and Ollama would keep evicting the other. If you must run with
   one slot, set `SLM_PIN_MODELS=off` too, and accept a reload whenever the two models take turns.
6. **Use doctor to sanity-check** the fit for your RAM:
   ```bash
   slm-gate doctor   # in a git checkout: node dist/cli.js doctor
   ```

After changing settings, run `slm-gate restart` (the model gate reads its settings when it starts), restart/refresh
MCP servers in Antigravity, and verify with `slm-gate doctor`.
