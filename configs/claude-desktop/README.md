# Claude Desktop MCP Configuration

**File Location:** `~/Library/Application Support/Claude/claude_desktop_config.json`

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

- **Without installing it:** `"command": "npx", "args": ["-y", "@zenithfoundry/slm-gate@1", "mcp"]`.
- **From a git checkout:** `"command": "node", "args": ["/full/path/to/small-language-model-gate/dist/mcp-gate/index.js"]`.
- **A toolbox behind `slm-gate` (optional):** add an `env` block to the entry, as in
  [Connect a toolbox](../../docs/install-from-npm.md#connect-a-toolbox-optional).

Then quit Claude Desktop completely, open it again, and check with `slm-gate doctor`.

## slm-gate shows as "Failed"

Claude Desktop starts MCP servers with only some of your environment, so it may not find programs that your
terminal finds, such as Node.js installed with nvm or Homebrew. The MCP guide's advice is to
[use a full path for the command](https://modelcontextprotocol.io/docs/tools/debugging). `slm-gate` itself starts
with Node.js, so give the full path of both:

```json
"slm-gate": {
  "command": "/full/path/to/node",
  "args": ["/full/path/to/node_modules/@zenithfoundry/slm-gate/dist/cli.js", "mcp"]
}
```

`which node` prints the first path. For the second, `npm root -g` prints the `node_modules` folder: add
`/@zenithfoundry/slm-gate/dist/cli.js` to the end. Claude Desktop's own logs are in `~/Library/Logs/Claude/`, in the files
starting with `mcp`.

## Ledger path: full path on your machine, or blank

Claude Desktop starts MCP servers from a working directory that does not exist. Any relative path in your configuration is resolved against that directory, so `LEDGER_PATH=./output/ledger.sqlite` makes the server fail on startup with `ENOENT: no such file or directory, mkdir './output'`, and Claude Desktop shows **slm-gate — Failed — Server disconnected**.

- Leave `LEDGER_PATH` blank in `.env` (the default is already a full path: `~/.slm-gate/output/ledger.sqlite`, or
  `output/ledger.sqlite` in a git checkout), **or**
- set it to the full path on your machine, in `.env` or in the `env` block above, for example `/Users/yourname/.slm-gate/output/ledger.sqlite`.

The same rule applies to every path inside `DOWNSTREAM_MCP`, and to the checkout path above. The configuration guide covers this in [Ledger Path Must Be a Full Path on Your Machine](../../docs/configuration.md#ledger-path-must-be-a-full-path-on-your-machine).

## Model gate (Layer 2): not possible in Claude Desktop

The Claude desktop app (chat and its Code tab) and claude.ai have no setting for the model's address, so their model requests can't go through the gate. Use the MCP server above (Layer 1) only. It still starts the model gate for your other coding tools; the `env` values above never reach the model gate, which reads only `slm-gate`'s `.env`.
