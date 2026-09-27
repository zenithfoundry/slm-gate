# Generic Stdio MCP Configuration

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
  [Connect a toolbox](../../docs/install-from-npm.md#connect-a-toolbox-optional).

Then restart your client and check with `slm-gate doctor`.

When your client starts this MCP server, it also starts the model gate (Layer 2) if it isn't running. If your client has a setting for the model's address, `slm-gate doctor` prints the line for the tools it knows; the `env` values above never reach the model gate, which reads only `slm-gate`'s `.env`.
