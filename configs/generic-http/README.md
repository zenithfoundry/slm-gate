# Generic HTTP MCP Configuration

For clients that connect via SSE/HTTP. Ensure you are running `slm-gate serve --layer mcp --transport http` in the background. Note: HTTP connections do not launch the process themselves, so you must start it manually. Once running, it starts and watches the model gate (Layer 2) the same way the stdio server does.

Only programs on this computer can connect. Other computers on your network, web pages from other sites, and clients inside a Docker container or virtual machine are refused, because this server's tools can read and change your files. Use `localhost` or `127.0.0.1` in the address, as below.

**File Location:** Depends on your MCP client's configuration schema.

```json
{
  "mcpServers": {
    "slm-gate": {
      "url": "http://localhost:8788/sse",
      "serverUrl": "http://localhost:8788/sse"
    }
  }
}
```

After adding this, make sure to build TLS first by running `pnpm run mcp:build` in your TLS directory, then restart/refresh MCP servers and verify with `slm-gate doctor`.
