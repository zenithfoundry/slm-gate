# Cursor MCP Configuration

**File Location:** `.cursor/mcp.json` (in your project root or workspace)

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": [
        "<ABS_PATH>/dist/mcp-gate/index.js"
      ],
      "env": {
        "TLS_ADAPTER": "on",
        "DOWNSTREAM_MCP": "{\"command\":\"node\",\"args\":[\"<ABS_PATH_TO_TLS>/dist/mcp-server.mjs\"]}"
      }
    }
  }
}
```

After adding this, make sure to build TLS first by running `pnpm run mcp:build` in your TLS directory, then restart/refresh MCP servers and verify with `slm-gate doctor`.

## Model gate (Layer 2): not possible in Cursor

Cursor sends every model request through its own servers first, even with "Override OpenAI Base URL" set, and those servers can't reach a server on your machine. Use the MCP server above (Layer 1) only. The MCP server still starts the model gate for your other coding tools.
