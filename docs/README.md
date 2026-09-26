# slm-gate docs

New here? Start with the [README](../README.md): what `slm-gate` does, and five diagrams showing how.

## Start here

Read these in order the first time.

- [Prerequisites & Hardware Sizing](./prerequisites-and-hardware.md): what to install, which local models fit your machine's memory, and fixing memory pressure
- [How It Operates](./integration-layers.md): the MCP gate and the model gate, who pays for what, and which coding tools work with each
- [Step-by-Step Setup](./setup.md): clone, build, download models, and connect Antigravity, Claude, Cursor, Cline, Continue, Codex or Gemini CLI
- [Configuration](./configuration.md): RAM presets, the 16 GB baseline `.env`, the ledger path, and every setting explained
- [Verification & Day-to-Day Use](./daily-use.md): the health check, what to do when the model gate can't start, checking savings, and the dashboard
- [Architecture & Advanced Features](./advanced.md): the hosted small-model fallback, and the structured-output rule for contributors

## Walkthroughs

- [Send your coding tool's requests through the model gate](./walkthrough-llm-gate.md)
- [Measure your savings](./walkthrough-measuring.md): a before-and-after comparison with the gate off and on

## Measuring

- [Analytics & observability](./analytics-and-observability.md): the local SQLite ledger, the dashboard, and Langfuse setup
- [Benchmark harness](../harness/README.md): the offline benchmark (API key needed)

## Editor configs

Each folder holds `.env` presets for 16, 24 and 32 GB machines, and the MCP config for that tool.

- [Antigravity](../configs/antigravity/README.md)
- [Claude Code](../configs/claude-code/README.md)
- [Claude Desktop](../configs/claude-desktop/README.md)
- [Cline, Continue & OpenCode](../configs/cline-continue-opencode/README.md)
- [Cursor](../configs/cursor/README.md)
- [Generic stdio](../configs/generic-stdio/README.md) and [generic HTTP](../configs/generic-http/README.md)
- [Preserved patterns](../configs/preserve/README.md): text the gate must never shrink

## Architecture

- [Architecture overview](../ARCHITECTURE.md): the components, credentials and billing, how the model gate stays running, local-only access
- [Context distillation and elision](./architecture/context-distillation-and-elision.md): how old tool output is dropped and recovered

## Contributing

- [Contributing](../.github/CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [House rules for coding agents](../AGENTS.md)
