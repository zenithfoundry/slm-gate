# Claude Desktop MCP Configuration

**File Location:** 
- Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

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

## Ledger path: full path on your machine, or blank

Claude Desktop starts MCP servers from a working directory that does not exist. Any relative path in your configuration is resolved against that directory, so `LEDGER_PATH=./output/ledger.sqlite` makes the server fail on startup with `ENOENT: no such file or directory, mkdir './output'`, and Claude Desktop shows **slm-gate — Failed — Server disconnected**.

- Leave `LEDGER_PATH` blank in `.env` (the default is already a full path under the install folder), **or**
- set it to the full path on your machine, in `.env` or in the `env` block above, for example `/Users/yourname/projects/small-language-model-gate/output/ledger.sqlite`.

The same rule applies to every path inside `DOWNSTREAM_MCP` and to `<ABS_PATH>` above. The configuration guide covers this in [Ledger Path Must Be a Full Path on Your Machine](../../docs/configuration.md#ledger-path-must-be-a-full-path-on-your-machine).

## Model gate (Layer 2): not possible in Claude Desktop

The Claude desktop app (chat and its Code tab) and claude.ai have no setting for the model's address, so their model requests can't go through the gate. Use the MCP server above (Layer 1) only. It still starts the model gate for your other coding tools; the `env` values above never reach the model gate, which reads only `slm-gate`'s `.env`.
