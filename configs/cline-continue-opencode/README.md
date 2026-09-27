# Cline / Continue / Opencode MCP Configuration

Each tool adds `slm-gate` as an MCP server that runs the command `slm-gate` with the argument `mcp`; only the file
and its format differ.

**Cline:** in the extension, click the MCP Servers icon → Configure → **Configure MCP Servers**. It opens Cline's
settings file (`cline_mcp_settings.json`). Add:

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

**Continue:** in `~/.continue/config.yaml` (all projects). Continue uses MCP servers in agent mode only.

```yaml
mcpServers:
  - name: slm-gate
    command: slm-gate
    args:
      - mcp
```

For one project only, put the same entry in its own file in the project's `.continue/mcpServers/` folder, with
`name: slm-gate`, `version: 0.0.1` and `schema: v1` above `mcpServers:`.

**OpenCode:** in `~/.config/opencode/opencode.json` (all projects) or `opencode.json` in a project's folder. The
command and its argument go in one list, and settings go in `environment` (not `env`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "slm-gate": {
      "type": "local",
      "command": ["slm-gate", "mcp"],
      "enabled": true
    }
  }
}
```

For all three:

- **Without installing it:** the command `npx` with the arguments `-y`, `@zenithfoundry/slm-gate@1`, `mcp`.
- **From a git checkout:** the command `node` with the argument
  `/full/path/to/small-language-model-gate/dist/mcp-gate/index.js`.
- **A toolbox behind `slm-gate` (optional):** add its settings to the entry (`env`; for OpenCode, `environment`), as
  in [Connect a toolbox](../../docs/install-from-npm.md#connect-a-toolbox-optional).

Then restart the tool and check with `slm-gate doctor`.

The `env` values above apply to this MCP server only. The model gate below is shared by all your coding tools and reads its settings only from `slm-gate`'s own `.env`.

## Model gate (Layer 2): send model requests through slm-gate

Works with your own API key. Models bundled in the tool's own subscription can't be redirected. The model gate starts by itself when the tool starts the MCP server above.

- **Cline / Roo Code:** Settings → API Provider **Anthropic** → tick **Use custom base URL** → `http://localhost:8787`
- **Continue** (`~/.continue/config.yaml`, on the model): `provider: anthropic`, `apiBase: http://localhost:8787/v1/` (OpenAI models: `provider: openai`, `apiBase: http://localhost:8787/v1`)
- **OpenCode** (`opencode.json`): `{ "provider": { "anthropic": { "options": { "baseURL": "http://localhost:8787/v1" } } } }`

Changed `LLM_GATE_PORT`? `slm-gate doctor` prints these lines with the new port, and the lines for Kilo Code, Zed, Copilot's Custom Endpoint, Junie CLI and Aider.
