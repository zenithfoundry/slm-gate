# Generic HTTP MCP Configuration

For clients that connect via SSE/HTTP. Ensure you are running `slm-gate serve --layer mcp --transport http` in the background. Note: HTTP connections do not launch the process themselves, so you must start it manually. Once running, it starts and watches the model gate (Layer 2) the same way the stdio server does.

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
