# Generic HTTP MCP Configuration

First: `npm install -g @zenithfoundry/slm-gate`, then `slm-gate init --profile starter` (or `proven` or `toolbox`,
see [Profiles](../../docs/npm/profiles.md)), the `ollama pull` line it prints, and `slm-gate doctor`
([Install](../../docs/npm/install.md)).

For clients that connect to an MCP server by web address (streamable HTTP; not the older SSE transport). Run `slm-gate serve --layer mcp --transport http` and keep it running: a client that connects by address does not start the server itself. Once running, it starts and watches the model gate the same way the stdio server does.

Only programs on this computer can connect. Other computers on your network, web pages from other sites, and clients inside a Docker container or virtual machine are refused, because this server's tools can read and change your files. Use `localhost` or `127.0.0.1` in the address, as below.

**File Location:** Depends on your MCP client's configuration schema.

```json
{
  "mcpServers": {
    "slm-gate": {
      "url": "http://localhost:8788/mcp"
    }
  }
}
```

Some clients name the field `serverUrl` (Antigravity), or also need `"type": "http"` next to `url` (Gemini CLI): follow your client's MCP documentation. `8788` is `MCP_GATE_PORT`. Check with `slm-gate doctor`.
