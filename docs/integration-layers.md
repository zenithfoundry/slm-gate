# How It Operates: Choosing Your Integration Layer

`slm-gate` has two independent operating modes — think of them as two different places where the gate can be inserted into your workflow. You can use one, the other, or both at the same time.

> **What each layer can see.** `mcp-gate` only sees what tools send back (skill files, file contents, command output). It never sees the messages you type, so it can only **shrink** those results. It can't answer your questions locally. `llm-gate` sits between your coding tool and the model, so it sees every request. It lets the small model try the first message of a conversation, and shrinks large command, search and listing output in every later request before it leaves your machine.
>
> | Dashboard card | Needs |
> |---|---|
> | Tokens Saved, Cost Saved, Routing Decision | either layer |
> | SLM Accuracy Rate | `llm-gate` (or `pnpm run bench`, shown under Env = `bench`) |
> | Claude / Gemini Cycle: Est. Seconds Saved (per prompt) + Est. Minutes Saved (total) | either layer **and** that provider's `*_WINDOW_BUDGET` |
> | ChatGPT Cycle: Est. Seconds Saved (per prompt) + Est. Minutes Saved (total) | `llm-gate` **and** `CHATGPT_WINDOW_BUDGET` |

## Layer 1: `mcp-gate` — The Tool & Skill Payload Compressor

**Best for:** Subscription users (Claude Pro, Cursor Pro, Gemini Advanced, ChatGPT Plus, etc.) who want to protect their turn and message quotas.

**How it works:** Your AI editor communicates with external tools using a standard called the **Model Context Protocol (MCP)**. When a tool returns a response — say, the contents of a large file or the output of a long-running command — that response goes into your editor's context window and costs you tokens. `mcp-gate` acts as a proxy that intercepts those tool responses *before* they reach your editor, compresses them using your local AI, and sends only the essential content onward.

You **do not need an API key** to use Layer 1. Your subscription-based editor handles the actual AI reasoning; `slm-gate` just keeps the context it receives clean and compact.

**The primary example — Tech-Lead-Stack:**

[Tech-Lead-Stack](https://github.com/bronz3beard/ai.tech-lead-stack) is a companion MCP server that turns your AI assistant into a full software-delivery team, working through structured phases from planning to code review. Its skill payloads can be large. With `slm-gate` in front of it, each skill payload is compressed before it hits your editor — dramatically reducing quota consumption per turn.

```
Your Editor (Claude Code, Cursor, etc.)
    │
    ▼
slm-gate (mcp-gate)      ← Intercepts & compresses tool payloads
    │
    ▼
Tech-Lead-Stack MCP      ← (or any other MCP server)
    │
    ▼
Your tools & files
```

To use Tech-Lead-Stack as your downstream:
1. Install and build Tech-Lead-Stack (`pnpm run mcp:build` in the TLS directory).
2. In your `slm-gate` config, set `DOWNSTREAM_MCP` to point at the TLS build path and set `TLS_ADAPTER=on`.

**Works with any MCP server.** Tech-Lead-Stack is the recommended companion, but `mcp-gate` is fully downstream-agnostic. Keep the gate registered as `slm-gate` whatever sits behind it. When a toolbox's own commands or docs call its tools by another server name (TLS's commands say `mcp__tech-lead-stack__get_skills`), the gate handles that for you: it reads the toolbox's tool list when it starts, tells your editor those tools live on `slm-gate`, and rewrites those names in what it returns. Swapping toolboxes needs no config change. Whatever a tool returns reaches your editor whole (pictures, several blocks of text, error flags, structured data); only large text is shrunk. Any MCP server — or a combination — can sit behind it. Popular options include:

| MCP Server | What It Does |
| :--- | :--- |
| [Tech-Lead-Stack](https://github.com/bronz3beard/ai.tech-lead-stack) | Full software delivery team (planning, review, security, release) |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | Official reference servers: Filesystem, Git, Memory, Fetch, PostgreSQL |
| [Firecrawl](https://github.com/mendableai/firecrawl) | Web scraping and crawling with structured output |
| [Browser MCP](https://github.com/browsermcp/mcp) | Browser automation and web interaction |
| [Linear](https://github.com/tacticlaunch/mcp-linear) | Project management and issue tracking |
| [GitHub MCP Server](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/github) | Repository management and GitHub API |
| [Sourcerer](https://github.com/st3v3nmw/sourcerer-mcp) | Semantic code search that reduces token waste |

> **No downstream MCP server?** That's fine too. Without a `DOWNSTREAM_MCP` configured, `mcp-gate` runs as a standalone MCP server exposing a single `condition_prompt` tool — you add it to your editor and it will compress any prompt you send through it.
>
> One behavioural difference to know about: the deterministic trimming rules (keep a file's skeleton, keep errors and the tail of a log, keep the top matches of a search) are selected by **tool name**, so they only apply when `slm-gate` is proxying a downstream server and can see which tool produced the output. A standalone `condition_prompt` call carries no tool name, so it has exactly one compression path — asking the local model to summarise — and that path only engages above `DISTILL_MAX_TOKENS`.

---

## Layer 2: `llm-gate` — The Model Endpoint Proxy

**Best for:** Anyone whose coding tool has a setting for the model's address: Claude Code, Codex, Gemini CLI (with an API key), Cline, Roo Code, Kilo Code, Continue, OpenCode, Zed, Copilot's Custom Endpoint, Junie CLI and Aider. It works with a subscription login and with an API key.

**How it works:** `llm-gate` (the "model gate") is a small server on your machine at `http://localhost:8787`. You change one setting in your coding tool so it sends its model requests there instead of straight to Anthropic, OpenAI or Google. For each request the gate:

1. **First message of a conversation:** lets your local model try to answer. If it can't, or its answer fails the check, the request carries on as below. Slash commands and coding tasks that need the tool's own tools always carry on.
2. **Every other request, tool steps included:** shrinks large command, search and listing output (tool results) before the request leaves your machine. Each result is shrunk once and the same shorter text is resent every later turn, so the provider's prompt cache keeps working. Nothing else in the request is changed.
3. **Sends the request to the provider the tool would have used anyway, with the tool's own login** (your Claude Pro/Max or ChatGPT login, or your API key). You are billed exactly as without the gate; there are just fewer, smaller requests.

```
Your coding tool
    │
    ▼
slm-gate (llm-gate)       ← on http://localhost:8787, started for you
    │ first message        → local model tries to answer
    │ everything else      → large tool output shrunk
    ▼
The tool's own provider (Anthropic, OpenAI, Google), with the tool's own login
```

**You never start it yourself.** When any coding tool starts `slm-gate`'s MCP server (Layer 1), the MCP server also starts the model gate in the background if it isn't running, and brings it back within a minute if it stops. It keeps running until you log out or restart. At the same moment it checks that Ollama is running and that every model your settings name is downloaded. Any problem shows up as a desktop notification and is passed to your AI assistant, which tells you about it with the fix. Nothing is started or downloaded for you. `slm-gate start`, `slm-gate stop` and `slm-gate restart` are there for when you want to control it by hand.

> **Where the model gate takes its settings from.** One model gate serves all your coding tools, so it reads its settings only from `slm-gate`'s own `.env` file. Values in a tool's MCP `"env"` block apply to that tool's MCP server only, never to the model gate.

> **Who can reach it.** Only programs on this computer. Other computers on your network can't connect, and a web page from another site is refused, even in your own browser. A coding tool running inside a Docker container or a virtual machine can't reach it either.

`slm-gate doctor` prints the exact line to paste into each coding tool, using your current port.

---

## Who Pays for What

Neither layer needs an API key of its own. Every request that reaches the cloud is billed exactly as it would be without `slm-gate`: to the subscription or API key your coding tool is logged in with. `slm-gate` only makes those requests fewer and smaller.

The `CLOUD_*` settings are optional and separate. They are read only by the benchmark (`slm-gate bench`), the resolver's optional cloud tier (`RESOLVER_CLOUD_TIER`) and a hosted small model (`SLM_PROVIDER=openai`). Most people leave them blank.

---

## Client Compatibility Matrix

| Client | Layer 1 (`mcp-gate`) | Layer 2 (`llm-gate`) | Login that works through Layer 2 |
| :--- | :---: | :---: | :--- |
| **Claude Code** (CLI, VS Code and JetBrains extensions) | ✅ | ✅ | claude.ai Pro/Max login or API key |
| **Codex** (CLI and IDE extension) | ✅ | ✅ | ChatGPT login or API key |
| **Gemini CLI**, **Antigravity CLI (`agy`)** | ✅ | ✅ | Gemini API key only |
| **Cline, Roo Code, Kilo Code, Continue, OpenCode, Zed, Junie CLI, Aider** | ✅ | ✅ | your own API key |
| **GitHub Copilot Chat** (Custom Endpoint) | ✅ | ✅ | your own API key |
| **Cursor, Windsurf** | ✅ | ❌ | — |
| **Claude Desktop** (chat and its Code tab), **claude.ai** | ✅ | ❌ | — |
| **Antigravity IDE / Antigravity 2** | ✅ | ❌ | — |
| **Gemini Code Assist, ChatGPT and Gemini apps** | not covered here | ❌ | — |

Why some tools can't use Layer 2:

- **Cursor and Windsurf** send every model request through the vendor's own servers first, and those servers can't reach a server on your machine.
- **Claude Desktop, claude.ai, Antigravity IDE, Gemini Code Assist, and the ChatGPT and Gemini apps** have no setting for the model's address.
- **Gemini CLI and `agy` with a Google-account login** ignore the address setting, and Google's terms say using that login through other tools may get the account suspended. Use a Gemini API key for Layer 2.
- **Models bundled in a tool's own subscription** (Cline, Kilo, Copilot and others) can't be redirected; only your own API key can.

> **Claude Pro/Max login through the gate.** Claude Code keeps using your claude.ai login when only its address is changed; Anthropic documents this. Anthropic's legal terms also say developers may not "intermediate Claude.ai credentials or session tokens". `slm-gate` only passes your own login from your own tool to Anthropic, on your own machine, but check the terms yourself before relying on it.

---

[README](../README.md) · [All docs](README.md) · Next: [Step-by-Step Setup Walkthrough](setup.md)
