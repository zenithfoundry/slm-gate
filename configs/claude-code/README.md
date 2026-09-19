# Claude Code MCP Configuration

**File Location:** `.mcp.json` (in your project root)

You can add this manually, or run the following one-liner (Note: on Windows, use `cmd /c` to run this properly if not in bash):

```bash
claude mcp add-json slm-gate '{"command":"node","args":["<ABS_PATH>/dist/mcp-gate/index.js"],"env":{"TLS_ADAPTER":"on","DOWNSTREAM_MCP":"{\\"command\\":\\"node\\",\\"args\\":[\\"<ABS_PATH_TO_TLS>/dist/mcp-server.mjs\\"]}"}}'
```

Alternatively, here is the raw JSON:

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

The `env` values above apply to this MCP server only. The model gate below is shared by all your coding tools and reads its settings only from `slm-gate`'s own `.env`.

## Model gate (Layer 2): send Claude Code's model requests through slm-gate

Add this to `~/.claude/settings.json` (no `/v1` at the end; Claude Code adds it):

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://localhost:8787" } }
```

In the VS Code extension, put it in your VS Code user settings instead:

```json
"claudeCode.environmentVariables": [{ "name": "ANTHROPIC_BASE_URL", "value": "http://localhost:8787" }]
```

- Your claude.ai Pro/Max login or API key keeps working.
- The model gate starts by itself when Claude Code starts the MCP server above. You don't run anything.
- Behind any address other than Anthropic's, Claude Code stops using server-side MCP tool search (`ENABLE_TOOL_SEARCH=true` turns it back on); Remote Control and server-managed settings are not available.
- The Claude desktop app's Code tab ignores this setting.
- Changed `LLM_GATE_PORT`? `slm-gate doctor` prints the line with the new port.
