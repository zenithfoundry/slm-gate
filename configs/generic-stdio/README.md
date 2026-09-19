# Generic Stdio MCP Configuration

**File Location:** Depends on your MCP client's configuration schema.

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

When your client starts this MCP server, it also starts the model gate (Layer 2) if it isn't running. If your client has a setting for the model's address, `slm-gate doctor` prints the line for the tools it knows; the `env` values above never reach the model gate, which reads only `slm-gate`'s `.env`.
