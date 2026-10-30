# slm-gate

**Make your AI coding plan last longer.** Two small local models shrink the large tool output your coding assistant sends to the paid cloud, and keep a short memory of each conversation. Works with Claude Code, Codex, Cursor, Gemini CLI, Cline and any MCP client. Runs on [Ollama](https://ollama.com/). Free and MIT-licensed.

**[See the live savings dashboard →](https://zenithfoundry.github.io/slm-gate/)** Measured from real daily use.

[![npm](https://img.shields.io/npm/v/@zenithfoundry/slm-gate)](https://www.npmjs.com/package/@zenithfoundry/slm-gate)
[![downloads](https://img.shields.io/npm/dm/@zenithfoundry/slm-gate)](https://www.npmjs.com/package/@zenithfoundry/slm-gate)
[![unpacked size](https://img.shields.io/npm/unpacked-size/@zenithfoundry/slm-gate)](https://www.npmjs.com/package/@zenithfoundry/slm-gate)
[![CI](https://github.com/zenithfoundry/slm-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/zenithfoundry/slm-gate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/zenithfoundry/slm-gate/actions/workflows/codeql.yml/badge.svg)](https://github.com/zenithfoundry/slm-gate/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/zenithfoundry/slm-gate/badge)](https://scorecard.dev/viewer/?uri=github.com/zenithfoundry/slm-gate)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14955/badge)](https://www.bestpractices.dev/projects/14955)
[![License](https://img.shields.io/github/license/zenithfoundry/slm-gate)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/zenithfoundry/slm-gate)](https://github.com/zenithfoundry/slm-gate/commits/main)
<br />
[![Node.js](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzenithfoundry%2Fslm-gate%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&color=brightgreen)](package.json)
[![TypeScript](https://img.shields.io/github/package-json/dependency-version/zenithfoundry/slm-gate/dev/typescript)](tsconfig.json)
[![MCP server](https://img.shields.io/badge/MCP-server-green)](https://modelcontextprotocol.io/)
[![Runs on Ollama](https://img.shields.io/badge/runs%20on-Ollama-black)](https://ollama.com/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](docs/reference/hardware.md)
[![Live dashboard](https://img.shields.io/badge/savings%20dashboard-live-blue)](https://zenithfoundry.github.io/slm-gate/)
[![AI setup prompt](https://img.shields.io/badge/AI%20setup-prompt-blueviolet)](docs/npm/ai-assisted-setup.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/zenithfoundry/slm-gate/pulls)

---

## What is slm-gate?

Your coding tool sends huge files, long logs and sprawling command output to the cloud AI with every message, and most of it is content the AI skims past. `slm-gate` (the CLI short name of `small-language-model-gate`) runs two small, free AI models on your own computer and shrinks that text before it leaves your machine. It never answers a prompt itself: every request still goes to the provider your tool uses, with your own login. Less is sent, so your plan's usage window lasts longer, and on a pay-per-token key you pay less for the same work.

It is two small servers, started for you:

- The **MCP gate** sits in front of your tools (optionally a whole [toolbox](docs/README.md#glossary) such as Tech-Lead-Stack) and shrinks what they return before your coding tool sees it. It adds a few tools of its own: `expand_elision` gets cut lines back, `ask_elision` answers a question about them locally, and `find_existing` lists code your repository already has.
- The **model gate** is a local address your coding tool sends its AI requests to. It shrinks the new tool output in each request, forwards it to the provider with your tool's own login, and keeps a short memory of the conversation so its local steps answer with the conversation in view.

Both record what they saved in a local ledger, which `slm-gate metrics`, the built-in dashboard and (optionally) Langfuse read. Nothing is billed differently, and less of your code leaves your machine.

## How it works

If a local model fails or runs out of time, the text it was working on goes on as it was.

![The two paths: a tool call goes through the MCP gate (optional toolbox, then shrink long text; skills under the fidelity guard) and back smaller; a model request goes through the model gate (shrink new tool output, forward with the tool's own login) and the reply comes back unchanged while the brain model folds the conversation memory when idle](docs/diagrams/request-path.png)

Explore it: [request-path.html](docs/diagrams/request-path.html) (open in a browser; nodes expand, paths can be traced).

Both gates write one row per request to the local ledger: token counts before and after, the route taken and timings, never the text. Minutes of your usage window are estimated from your plan.

![Where the numbers go: both gates write rows to the ledger (src/ledger/); slm-gate metrics, the dashboard and the optional Langfuse mirror read it; plans and window sizes turn tokens saved into estimated minutes; the dashboard's aggregates are published to GitHub Pages daily](docs/diagrams/where-the-data-goes.png)

Explore it: [where-the-data-goes.html](docs/diagrams/where-the-data-goes.html) (open in a browser; nodes expand, paths can be traced).

Step by step, with the diagrams for one tool call, one model request and the start-up: [How it works](docs/reference/how-it-works.md).

## Quick Start

You need a Mac or Linux computer with 16 GB of RAM or more, Node.js 22+ and [Ollama](https://ollama.com/download) running.

```bash
npm install -g @zenithfoundry/slm-gate
slm-gate init        # creates ~/.slm-gate/.env for this computer's RAM; --profile starter|proven|toolbox
slm-gate doctor      # after the `ollama pull` line init printed; ends with READY
```

Then add an MCP server to your coding tool that runs `slm-gate` with the argument `mcp`. For Claude Code: `claude mcp add --scope user slm-gate -- slm-gate mcp`. `doctor` also prints the one line that sends the tool's own AI requests through the gate. Every step, every tool: [Install](docs/npm/install.md).

> **Rather have an AI assistant set it up?** After the install line, paste the [AI setup prompt](docs/npm/ai-assisted-setup.md) into Claude Code, Codex, Gemini CLI or any other assistant. It checks your computer, asks a few questions, and connects everything.

**From source** (to change `slm-gate` itself): [Set up from source](docs/source/setup.md).

## Documentation

All pages, in reading order, with a glossary: [docs/README.md](docs/README.md).

| Section | Pages |
| :--- | :--- |
| **Installed from npm** | [Install](docs/npm/install.md) · [Profiles](docs/npm/profiles.md) · [Connect your tool](docs/npm/connect-your-tool.md) · [Daily use](docs/npm/daily-use.md) · [Measure your savings](docs/npm/measure-savings.md) · [AI-assisted setup](docs/npm/ai-assisted-setup.md) |
| **From source (contributors)** | [Set up from source](docs/source/setup.md) · [Switch to npm](docs/source/switch-to-npm.md) · [Diagrams](docs/source/diagrams.md) · [Architecture](ARCHITECTURE.md) · [AGENTS.md](AGENTS.md) |
| **Reference (both)** | [Settings](docs/reference/settings.md) · [Hardware](docs/reference/hardware.md) · [How it works](docs/reference/how-it-works.md) · [Analytics](docs/reference/analytics.md) |

## Contributing & Security

Pull requests are welcome; read the [contributing guide](.github/CONTRIBUTING.md) first. For help, and what is supported, see [support](SUPPORT.md). Please report security problems privately, as the [security policy](SECURITY.md) describes, not in a public issue.

## Related Project

> [!NOTE]
> **Tech-Lead-Stack:** An agent-agnostic library of Markdown "skills" plus an MCP server that turns Claude, Gemini, or GPT into a full software-delivery team (planning, building, review, security, release), organized around a nine-phase lifecycle. `slm-gate` can sit in front of it and shrink its skill payloads: `slm-gate init --profile toolbox`.
>
> <a href="https://github.com/bronz3beard/ai.tech-lead-stack" target="_blank" rel="noopener noreferrer">Explore tech-lead-stack on GitHub →</a>

## Intended Use

This software runs locally and drives third-party AI tools and models that **you** install and authenticate. You are responsible for complying with the terms of any tool, model, or subscription you connect to it. It is designed for single-user, local use with your own accounts; it does not proxy or share third-party credentials between users. Provided "as is" under the MIT License, without warranty of any kind.

## License

[MIT](LICENSE)
