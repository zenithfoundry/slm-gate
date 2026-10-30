# Connect your tool

The MCP entry for each coding tool, and which tools can also send their AI requests through the gate.

Every tool needs the same MCP entry: an MCP server named `slm-gate` that runs the command `slm-gate` with the
argument `mcp`. Only the file and its format differ. Each page below shows it, and the `npx` form for a tool
that should start `slm-gate` without installing it.

| Tool | Page |
| :--- | :--- |
| Antigravity (IDE, Antigravity 2, `agy` CLI) | [configs/antigravity](../../configs/antigravity/README.md) |
| Claude Code (CLI, VS Code and JetBrains extensions) | [configs/claude-code](../../configs/claude-code/README.md) |
| Claude Desktop | [configs/claude-desktop](../../configs/claude-desktop/README.md) |
| Cline, Continue, OpenCode | [configs/cline-continue-opencode](../../configs/cline-continue-opencode/README.md) |
| Cursor | [configs/cursor](../../configs/cursor/README.md) |
| Codex | `codex mcp add slm-gate -- slm-gate mcp` (CLI and IDE extension share `~/.codex/config.toml`) |
| Gemini CLI | `gemini mcp add -s user slm-gate slm-gate mcp` (without `-s user` it works in one folder only) |
| Any other tool that starts MCP servers | [generic stdio](../../configs/generic-stdio/README.md) |
| Any tool that connects by web address | [generic HTTP](../../configs/generic-http/README.md) |

Restart the tool after adding the entry. It then shows `slm-gate` as connected, with your toolbox's tools under
it if you have one. `slm-gate doctor` checks the rest.

A value in the entry's `env` block applies to that tool's MCP gate only; the shared model gate reads only
`~/.slm-gate/.env` ([Where settings come from](install.md#where-settings-come-from)).

## Send the tool's AI requests through the gate too

Tools that let you change where their AI requests go can send them through the model gate, which shrinks the
large command, search and listing output in each request before it leaves your computer, then passes the request
to the same provider with the tool's own login or key. Nothing is billed differently; less is sent.

**Run `slm-gate doctor`.** Its "Coding tool settings" section prints the exact line for each tool, with your
current port. Copy it from there rather than from memory: each tool wants the address in a slightly different
form (with or without `/v1`, or the full path), and the lines change when you change `LLM_GATE_PORT`.

| Tool | MCP gate | Model gate | Login that works through the model gate |
| :--- | :---: | :---: | :--- |
| **Claude Code** (CLI, VS Code and JetBrains extensions) | yes | yes | claude.ai Pro/Max login or API key |
| **Codex** (CLI and IDE extension) | yes | yes | ChatGPT login or API key |
| **Gemini CLI**, **Antigravity CLI (`agy`)** | yes | yes | Gemini API key only |
| **Cline, Roo Code, Kilo Code, Continue, OpenCode, Zed, Junie CLI, Aider** | yes | yes | your own API key |
| **GitHub Copilot Chat** (Custom Endpoint) | yes | yes | your own API key |
| **Cursor, Windsurf** | yes | no | |
| **Claude Desktop** (chat and its Code tab), **claude.ai** | yes | no | |
| **Antigravity IDE / Antigravity 2** | yes | no | |
| **Gemini Code Assist, the ChatGPT and Gemini apps** | not covered here | no | |

Why some tools cannot:

- **Cursor and Windsurf** send every model request through the vendor's own servers first, and those servers
  cannot reach a server on your computer.
- **Claude Desktop, claude.ai, Antigravity IDE, Gemini Code Assist, and the ChatGPT and Gemini apps** have no
  setting for the model's address.
- **Gemini CLI and `agy` with a Google-account login** ignore the address setting, and Google's terms say using
  that login through other tools may get the account suspended. Use a Gemini API key.
- **Models bundled in a tool's own subscription** (Cline, Kilo, Copilot and others) cannot be redirected; only
  your own API key can.

> **Claude Pro/Max login through the gate.** Claude Code keeps using your claude.ai login when only its address
> is changed; Anthropic documents this. Anthropic's legal terms also say developers may not "intermediate
> Claude.ai credentials or session tokens". `slm-gate` only passes your own login from your own tool to
> Anthropic, on your own computer, but check the terms yourself before relying on it.

**Only programs on this computer can reach the gate.** Other computers on your network cannot connect, a web
page from another site is refused, and so is a coding tool running inside a Docker container or a virtual
machine.

---

Next: [Daily use](daily-use.md)
