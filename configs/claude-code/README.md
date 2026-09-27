# Claude Code MCP Configuration

Add `slm-gate` for all your projects with one command:

```bash
claude mcp add --scope user slm-gate -- slm-gate mcp
```

- **Without installing it:** `claude mcp add --scope user slm-gate -- npx -y @zenithfoundry/slm-gate@1 mcp`
- **From a git checkout:** `claude mcp add --scope user slm-gate -- node /full/path/to/small-language-model-gate/dist/mcp-gate/index.js`
- **For one project only:** leave out `--scope user`, or put the entry in `.mcp.json` in the project's folder:

  ```json
  { "mcpServers": { "slm-gate": { "command": "slm-gate", "args": ["mcp"] } } }
  ```

**A toolbox behind `slm-gate` (optional).** Add the entry with its `env` values instead. For example,
Tech-Lead-Stack from npm:

```bash
claude mcp add-json --scope user slm-gate '{"command":"slm-gate","args":["mcp"],"env":{"DOWNSTREAM_MCP":"{\"command\":\"npx\",\"args\":[\"-y\",\"tech-lead-stack@1\"]}","TLS_ADAPTER":"on"}}'
```

Other toolboxes: see [Connect a toolbox](../../docs/install-from-npm.md#connect-a-toolbox-optional). To change an
existing entry, `claude mcp remove slm-gate --scope user` first; `claude mcp get slm-gate` shows what it holds.

Then restart Claude Code. `claude mcp list` shows `slm-gate` as connected, and `slm-gate doctor` checks the rest.

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
