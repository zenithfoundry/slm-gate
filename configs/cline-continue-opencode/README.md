# Cline / Continue / Opencode MCP Configuration

**File Location:** `cline_mcp.json` or `.continue/config.json` (depends on client, usually at the global or project root)

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

## Model gate (Layer 2): send model requests through slm-gate

Works with your own API key. Models bundled in the tool's own subscription can't be redirected. The model gate starts by itself when the tool starts the MCP server above.

- **Cline / Roo Code:** Settings → API Provider **Anthropic** → tick **Use custom base URL** → `http://localhost:8787`
- **Continue** (`~/.continue/config.yaml`, on the model): `provider: anthropic`, `apiBase: http://localhost:8787/v1/` (OpenAI models: `provider: openai`, `apiBase: http://localhost:8787/v1`)
- **OpenCode** (`opencode.json`): `{ "provider": { "anthropic": { "options": { "baseURL": "http://localhost:8787/v1" } } } }`

Changed `LLM_GATE_PORT`? `slm-gate doctor` prints these lines with the new port, and the lines for Kilo Code, Zed, Copilot's Custom Endpoint, Junie CLI and Aider.
