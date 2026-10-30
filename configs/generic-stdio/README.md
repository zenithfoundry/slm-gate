# Generic Stdio MCP Configuration

First: `npm install -g @zenithfoundry/slm-gate`, then `slm-gate init --profile starter` (or `proven` or `toolbox`,
see [Profiles](../../docs/npm/profiles.md)), the `ollama pull` line it prints, and `slm-gate doctor`
([Install](../../docs/npm/install.md)). Then add the entry below.

**File Location:** Depends on your MCP client's configuration schema.

Add an MCP server named `slm-gate` that runs the command `slm-gate` with the argument `mcp`. Most clients use this
shape:

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

Then restart your client and check with `slm-gate doctor`.

When your client starts this MCP server, it also starts the model gate if it isn't running. If your client has a setting for the model's address, `slm-gate doctor` prints the line for the tools it knows; the `env` values above never reach the model gate, which reads only `slm-gate`'s `.env`.
