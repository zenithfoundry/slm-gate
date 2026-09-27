# Cursor MCP Configuration

**File Location:** `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in a project's folder (that project only)

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
- **Cursor can't start it?** Cursor needs the command on your system path, or its full path: see
  [slm-gate shows as "Failed"](../claude-desktop/README.md#slm-gate-shows-as-failed).

Then restart Cursor and check with `slm-gate doctor`.

## Model gate (Layer 2): not possible in Cursor

Cursor sends every model request through its own servers first, even with "Override OpenAI Base URL" set, and those servers can't reach a server on your machine. Use the MCP server above (Layer 1) only. The MCP server still starts the model gate for your other coding tools.
