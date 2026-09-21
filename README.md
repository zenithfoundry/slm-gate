# small-language-model-gate

[![CI](https://github.com/bronz3beard/small-language-model-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/bronz3beard/small-language-model-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](tsconfig.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/bronz3beard/small-language-model-gate/pulls)

> [!NOTE]
> **Related project — Tech-Lead-Stack:** An agent-agnostic library of Markdown "skills" plus an MCP
> server that turns Claude, Gemini, or GPT into a full software-delivery team (planning,
> building, review, security, release), organized around a nine-phase lifecycle. Its
> self-correcting Reflexion loop grades implementation plans against four engineering
> pillars before any code is written.
>
> <a href="https://github.com/bronz3beard/ai.tech-lead-stack" target="_blank" rel="noopener noreferrer">Explore tech-lead-stack on GitHub →</a>

---

## Table of Contents

1. [What is slm-gate?](#1-what-is-slm-gate)
2. [Prerequisites & Hardware Sizing](#2-prerequisites--hardware-sizing)
3. [How It Operates: Choosing Your Integration Layer](#3-how-it-operates-choosing-your-integration-layer)
4. [Step-by-Step Setup Walkthrough](#4-step-by-step-setup-walkthrough)
5. [Configuration Setup Guide](#5-configuration-setup-guide)
6. [Verification & Day-to-Day Use](#6-verification--day-to-day-use)
7. [Architecture & Advanced Features](#7-architecture--advanced-features)

---

## 1. What is slm-gate?

`small-language-model-gate` (CLI shortname: **`slm-gate`**) is a **local AI pre-processing and routing layer** that sits in front of your AI coding assistant and quietly does two very useful things before anything reaches the paid cloud:

**It compresses the noise.** Your editor constantly packages up huge files, long logs, and sprawling system instructions and sends them to the cloud AI with every single message. Most of that is content the AI skims past. `slm-gate` intercepts this, runs a small, fast, free AI on your own computer, and strips it down to what actually matters — sending a fraction of the original text to the cloud.

**It answers easy questions locally.** Many conversations open with something a small model can answer — a quick fact, a short explanation, a greeting. `slm-gate` lets your local model try the first message of each conversation; if its answer passes a check, that request never reaches your paid plan at all. Anything else, and every slash command, goes to the cloud as normal.

The result: your paid AI plan lasts dramatically longer. Whether you're on a subscription (Claude Pro, Cursor Pro, Gemini Advanced, ChatGPT Plus) or paying per-token via an API key, you spend far less on the same amount of real work.

### Why You Need This

Every AI subscription comes with rate limits. Claude Pro's five-hour windows, Cursor's monthly turn caps, ChatGPT Plus's hourly message limits — these aren't just numbers. Hit them mid-project and you're waiting hours to continue. `slm-gate` acts as a buffer. By intercepting routine traffic and compressing what does go to the cloud, your effective quota stretches much further.

On pay-per-token API plans (like `gpt-4o` or Claude Sonnet via API key), every token costs money. Sending a 500-line file when the model only needed 30 lines of context is a direct waste of budget. `slm-gate` eliminates that waste automatically.

### Key Benefits

| Benefit | What It Means For You |
| :--- | :--- |
| **Quota Protection** | Fewer turns and tokens consumed means your subscription window lasts longer |
| **$0 Local Execution** | Small, repetitive queries answered free by your local machine |
| **Context Compression** | Large files, logs, and tool responses trimmed intelligently before hitting the cloud |
| **Privacy** | Less of your actual code and data leaves your machine |
| **Provider-Agnostic** | Works with Claude, GPT, Gemini, or any OpenAI-compatible endpoint |

### What Gets Measured: Your Savings Dashboard

`slm-gate` records every decision it makes in a local database file on your computer (a SQLite database — think of it as a simple, fast spreadsheet that lives on your machine). For every request, it logs:

- How many tokens (units of text) were in the original payload
- How many tokens remained after compression
- Whether the request was answered locally (free) or forwarded to the cloud (answering locally is `llm-gate` only; see [Section 3](#3-how-it-operates-choosing-your-integration-layer))
- How long the local processing took
- The simulated dollar cost saved (for API key users)

**Checking your savings is one command:**

```bash
pnpm run slm-gate metrics
```

This prints a clean, offline summary showing tokens saved, compression ratio, requests handled locally, and how many extra minutes of subscription headroom you've gained — no API keys, no internet connection required.

**Want a visual dashboard?** If you set up [Langfuse](https://langfuse.com/) (a free, open-source observability tool), `slm-gate` will also send traces there, giving you graphs, latency breakdowns, and session-by-session analysis. Langfuse is completely optional — the local metrics command always works regardless.

### How It Works: Visual
<img width="825" height="768" alt="Screenshot 2026-09-10 at 12 30 05 pm" src="https://github.com/user-attachments/assets/81d09734-234e-441f-9213-881ef219bedd" />

---

## 2. Prerequisites & Hardware Sizing

### Required Software

Before you start, you need three things installed on your computer:

**1. Node.js (version 22 or later)**

Node.js is the runtime that `slm-gate` itself runs on. Check if you have it:

```bash
node -v
# Should print: v22.x.x or higher (22, 24 and 26 are all supported)
```

If not, download it from [nodejs.org](https://nodejs.org/) (choose the LTS version).

> _No compiler or Xcode Command Line Tools are needed. The one native dependency (`better-sqlite3`) ships prebuilt binaries for macOS, Linux and Windows, and `pnpm install` uses them as-is. Node 20 reached end-of-life and is no longer supported: `pnpm install` prints an `Unsupported engine` warning on it and `doctor` reports an issue._

**2. pnpm (package manager)**

`pnpm` is the tool used to install `slm-gate`'s dependencies. Install it once:

```bash
npm install -g pnpm
```

**3. Ollama (the local AI runner)**

Ollama is a free program that downloads and runs small AI models on your machine — no cloud account needed. Install it from [ollama.com](https://ollama.com/download) and make sure it's running. You can verify with:

```bash
ollama list
# Should print a list of downloaded models (empty is fine initially)
```

Ollama should be reachable at `http://localhost:11434` (its default address).

### Optional Prerequisites

These are not required to get started, but unlock additional capabilities:

- **[Langfuse](https://langfuse.com/)** — A free, open-source web dashboard for visualising your AI usage and token savings. Self-hostable or use the cloud version. You only need this if you want richer visual analytics beyond the CLI metrics command.
- **Cloud API Key** — An `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or similar. Only needed if you plan to use Layer 2 (`llm-gate` for model endpoint routing) or run the offline benchmarking harness. For Layer 1 subscription users, no API key is needed.
- **[Tech-Lead-Stack](https://github.com/bronz3beard/ai.tech-lead-stack)** — An optional companion MCP server that `slm-gate` can sit in front of. See [Section 3](#3-how-it-operates-choosing-your-integration-layer) for details.

---

### Machine Sizing & Hardware Recommendations

<a id="appendix-c-ram-by-machine-model-table"></a>

Choosing the right local AI model for your machine is the single most important setup decision. Too large a model and your computer will slow to a crawl; too small and the compression quality suffers.

#### ⚡ Built-In Preflight Diagnostic Tools

Before downloading any models, let `slm-gate`'s built-in tools tell you exactly what your machine can handle:

```bash
# 1. Inspect your pulled models and get two personalised preset recommendations:
npm run models:check
# or: node dist/cli.js models:check

# 2. Run a full hardware + connectivity check:
pnpm run dev doctor
# or: node dist/cli.js doctor
```

- **`models:check`** reads your installed Ollama models, calculates their total memory footprint, and recommends two configurations tailored to your machine:
  - **Option A (Dedicated AI Node):** Maximises model quality when `slm-gate` is the main workload on this machine.
  - **Option B (Primary Workhorse):** Leaves enough memory free for your OS, browser, and IDE to avoid slowdowns and disk swapping.
- **`doctor`** detects your CPU architecture (Apple Silicon, Intel, CUDA), measures your available RAM, verifies Ollama is reachable, checks whether your context window setting (`NUM_CTX`) fits your hardware, and automatically writes a safe fallback configuration if it detects potential memory issues.

> [!TIP]
> **Not sure which models run well on your exact machine? Use `llmfit`.**
>
> [AlexsJones/llmfit](https://github.com/AlexsJones/llmfit) is an open-source terminal tool (with both a CLI and an interactive terminal UI) that right-sizes local AI models to your specific machine — measuring your RAM, CPU, GPU/VRAM, and estimating real tokens-per-second performance. It scores models across quality, speed, fit, and context dimensions, and supports Ollama, llama.cpp, MLX, and Docker Model Runner.
>
> ```bash
> # macOS / Linux (Homebrew)
> brew install AlexsJones/llmfit/llmfit
>
> # Windows (Scoop)
> scoop install llmfit
> ```

#### RAM-by-Machine Model Table

Use the table below to pick your starting models. The **RAM Preset** column maps directly to the preset `.env` files in the `configs/` folder — you can copy the matching preset instead of configuring from scratch.

| RAM | RAM Preset | Brain Model (Smarter, Heavier Tasks) | Gate Model (Fast Router, Quick Decisions) |
| :--------- | :---------- | :--------------------------------- | :---------------------------- |
| **16 GB** | `ram-16` | `qwen2.5-coder:3b`, `tinyllama` | `qwen2.5-coder:0.5b` |
| **24 GB** | `ram-24` | `qwen3.5:4b`, `llama3.2:3b` | `qwen2.5-coder:3b`, `phi3:mini` |
| **32 GB** | `ram-32` | `qwen2.5:7b`, `mistral:7b` | `qwen2.5-coder:3b`, `phi3:mini` |
| **64 GB** | `ram-64` | `qwen3.5:9b`, `llama3:8b` | `qwen3.5:4b`, `llama3.2:3b` |
| **128 GB** | `ram-128` | `qwen3:14b`, `llama3:70b (Q4)` | `qwen3:7b`, `mistral:7b` |

> **What is the "Brain" vs. "Gate" model?** `slm-gate` uses two local models:
> - The **Gate model** is tiny and fast. Its only job is to make split-second routing decisions: "Can I handle this locally, or does it need to go to the cloud?" Speed is everything here.
> - The **Brain model** is slightly larger and smarter. It does the actual compression, summarisation, and local resolution when the Gate decides a request can be handled on-device.

#### Dual-Model Setup: Keeping Both Models Ready at Once

When running both a Gate model and a Brain model, you want both loaded in memory at the same time — otherwise Ollama has to swap one out every time it switches, adding several seconds of latency to each request.

```bash
# macOS (set permanently via launchctl)
launchctl setenv OLLAMA_MAX_LOADED_MODELS 2

# Linux / any terminal session
export OLLAMA_MAX_LOADED_MODELS=2
```

> **Note on Memory Limits:** Loading two models simultaneously means Ollama must allocate memory for both their caches at once. On Apple Silicon Macs, this is strictly capped by the amount of unified memory (RAM) you have.
> - **24 GB Mac:** Set `NUM_CTX=8192` to safely fit both models.
> - **16 GB Mac:** Set `NUM_CTX=4096` to safely fit both models.
>
> If one model keeps getting unloaded to make room for the other, lower your `NUM_CTX` value.

#### 🍏 macOS + Homebrew Users: Avoid This Common Pitfall

If you installed Ollama via Homebrew (`brew install ollama`), there is a well-known configuration trap you must avoid.

> [!WARNING]
> **The Homebrew Configuration Trap:** Running `brew services restart ollama` **silently overwrites** the Ollama launch configuration file at `~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`. Any custom environment variables you have added — such as `OLLAMA_MAX_LOADED_MODELS` or `OLLAMA_KEEP_ALIVE` — will be deleted without warning. This causes models to be aggressively swapped in and out of memory, resulting in very slow responses and context being truncated.

**The Permanent Fix:**

1. Stop the Homebrew-managed Ollama service:
   ```bash
   brew services stop ollama
   ```
2. Open `~/Library/LaunchAgents/homebrew.mxcl.ollama.plist` in a text editor and manually add your required environment variables:
   ```xml
   <key>EnvironmentVariables</key>
   <dict>
     <key>OLLAMA_CONTEXT_LENGTH</key><string>8192</string>
     <key>OLLAMA_KEEP_ALIVE</key><string>12h</string>
     <key>OLLAMA_MAX_LOADED_MODELS</key><string>2</string>
   </dict>
   ```
3. Load the configuration natively (bypassing Homebrew's restart mechanism):
   ```bash
   launchctl load ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist
   ```

*For more details, see the [official Ollama FAQ on memory and concurrency](https://github.com/ollama/ollama/blob/main/docs/faq.md).*

#### Memory Pressure Troubleshooting

If your computer feels sluggish after starting `slm-gate`, or models keep unloading unexpectedly, the culprit is almost always memory. Here is how to think about it:

```
Total Memory Used = Model Weights + (Context Window Size × KV Cache) × Number of Models Loaded
```

In plain terms: the bigger your models and the larger the context window (`NUM_CTX`), the more RAM gets used. The two biggest levers you have are:

1. **Drop `NUM_CTX` first.** Halving the context window (e.g., from `8192` to `4096`) saves a very significant amount of memory — often more than switching to a smaller model. Do this first.
2. **Switch to a smaller Brain model.** If memory is still tight after reducing `NUM_CTX`, drop down one row in the RAM table above (e.g., from 9B to 7B to 3B).
3. **Force single-model mode as a last resort.** Setting `OLLAMA_MAX_LOADED_MODELS=1` forces Ollama to only keep one model in memory at a time. Switching between Gate and Brain will be slower, but the total memory usage drops significantly.

**Step-by-step troubleshooting checklist:**

```bash
# 1. See what models you currently have downloaded
ollama list

# 2. Run the built-in memory fitness check
pnpm run dev doctor
```

Then in your `.env` (or your editor's MCP config block), adjust:
```bash
SLM_BRAIN_MODEL=qwen2.5:7b      # Try a smaller brain model
SLM_GATE_MODEL=qwen2.5-coder:0.5b  # Keep the gate model tiny
NUM_CTX=4096                     # This is the biggest single win
OLLAMA_MAX_LOADED_MODELS=2       # Or set to 1 if still tight
```

*You must pull any new model before using it: `ollama pull <model-name>`*

---

## 3. How It Operates: Choosing Your Integration Layer

`slm-gate` has two independent operating modes — think of them as two different places where the gate can be inserted into your workflow. You can use one, the other, or both at the same time.

> **What each layer can see.** `mcp-gate` only sees what tools send back (skill files, file contents, command output). It never sees the messages you type, so it can only **shrink** those results. It can't answer your questions locally. `llm-gate` sits between your coding tool and the model, so it sees every request. It lets the small model try the first message of a conversation, and shrinks large command, search and listing output in every later request before it leaves your machine.
>
> | Dashboard card | Needs |
> |---|---|
> | Tokens Saved, Cost Saved, Routing Decision | either layer |
> | SLM Accuracy Rate | `llm-gate` (or `pnpm run bench`, shown under Env = `bench`) |
> | Claude / Gemini Cycle: Est. Seconds Saved (per prompt) + Est. Minutes Saved (total) | either layer **and** that provider's `*_WINDOW_BUDGET` |
> | ChatGPT Cycle: Est. Seconds Saved (per prompt) + Est. Minutes Saved (total) | `llm-gate` **and** `CHATGPT_WINDOW_BUDGET` |

### Layer 1: `mcp-gate` — The Tool & Skill Payload Compressor

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

### Layer 2: `llm-gate` — The Model Endpoint Proxy

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

### Who Pays for What

Neither layer needs an API key of its own. Every request that reaches the cloud is billed exactly as it would be without `slm-gate`: to the subscription or API key your coding tool is logged in with. `slm-gate` only makes those requests fewer and smaller.

The `CLOUD_*` settings are optional and separate. They are read only by the benchmark (`slm-gate bench`), the resolver's optional cloud tier (`RESOLVER_CLOUD_TIER`) and a hosted small model (`SLM_PROVIDER=openai`). Most people leave them blank.

---

### Client Compatibility Matrix

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

## 4. Step-by-Step Setup Walkthrough

Follow these steps in order. By the end, `slm-gate` will be running and wired up to your editor. Then head to [Section 5](#5-configuration-setup-guide) to fine-tune your settings.

---

### Step 1 — Clone the Repository

Open a terminal and run:

```bash
git clone https://github.com/bronz3beard/small-language-model-gate.git
cd small-language-model-gate
```

This downloads `slm-gate` into a folder called `small-language-model-gate` in your current directory.

---

### Step 2 — Install Dependencies & Build

```bash
pnpm install
pnpm run build
```

`pnpm install` downloads all the code libraries `slm-gate` needs. `pnpm run build` compiles the TypeScript source into runnable JavaScript files in the `dist/` folder. You should see no errors.

> _If you later modify any `.ts` source files, run `pnpm run build` again to pick up changes._

**The `slm-gate` command.** This README writes commands as `slm-gate doctor`, `slm-gate restart` and so on. To have that short command everywhere, run `pnpm link --global` in this folder once (it needs `pnpm setup` to have been run once on your machine). Without it, use `node dist/cli.js doctor` from this folder. `slm-gate`'s own warnings always print the full command, e.g. `node /Users/yourname/projects/small-language-model-gate/dist/cli.js restart`, so they work either way.

---

### Step 3 — Start Ollama & Download Local Models

Make sure Ollama is running. How you start it depends on how you installed it:

```bash
# Installed with Homebrew (it then runs in the background from login)
brew services start ollama

# Installed as the macOS app — look for the llama icon in your menu bar
open -a Ollama

# Installed as a plain binary, or on Linux without a systemd unit
ollama serve

# Linux, installed with the official script (systemd)
sudo systemctl start ollama
```

If `ollama serve` prints `address already in use`, **Ollama is already running** — Homebrew or systemd started it for you. That is not an error to fix. Check with `ollama ps`, or `curl http://localhost:11434/api/tags`.

`slm-gate` works out which of these applies to your machine and names the right command in any notification it shows you.

Then download the models for your machine. For a **16 GB machine** (the recommended starting point):

```bash
ollama pull qwen2.5-coder:3b    # Brain model: smarter, used for compression & local resolution
ollama pull qwen2.5-coder:0.5b  # Gate model: tiny, used for quick routing decisions
```

Check the [RAM table in Section 2](#ram-by-machine-model-table) to find the right models for your machine's memory.

> _Not sure what to pick? Run `npm run models:check` after pulling a model and it will recommend the best pair for your hardware._

---

### Step 4 — Wire Up Your Editor / Client

Find your editor below and follow those steps. Each client config uses an **absolute path** to the built `slm-gate` file — replace `<ABS_PATH>` with the full path to where you cloned the repo.

To find your absolute path, run this in your terminal from inside the `small-language-model-gate` folder:

```bash
pwd
# Example output: /Users/yourname/projects/small-language-model-gate
```

Your built MCP entry point will be at: `/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js`

---

#### Google Antigravity (Antigravity IDE, Antigravity 2, `agy` CLI)

Antigravity reads its MCP server list from a global configuration file. You add `slm-gate` there.

**File to edit:** `~/.gemini/config/mcp_config.json`

If the file doesn't exist yet, create it. Add (or merge) the following into the `mcpServers` block:

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": [
        "/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"
      ],
      "env": {
        "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
        "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
        "NUM_CTX": "4096",
        "OLLAMA_MAX_LOADED_MODELS": "2"
      }
    }
  }
}
```

> **Important:** For Antigravity, values in this JSON `"env"` block override `slm-gate`'s `.env` for the MCP server inside Antigravity. The model gate reads only `slm-gate`'s `.env`, so copy the preset for your RAM from `configs/antigravity/` to `.env` too, and keep the model settings the same in both places.

**Using Tech-Lead-Stack as your downstream?** Add these two extra keys to the `env` block:
```json
"TLS_ADAPTER": "on",
"DOWNSTREAM_MCP": "{\"command\":\"node\",\"args\":[\"/abs/path/to/tech-lead-stack/dist/mcp-server.mjs\"]}"
```

After saving, reload MCP servers in Antigravity (usually via the Settings → MCP panel or a restart).

See the full config reference: [`configs/antigravity/README.md`](configs/antigravity/README.md)

---

#### Claude (Claude Code & Claude Desktop)

**Claude Code** (the `claude` terminal app):

The easiest way to add `slm-gate` to Claude Code is the CLI one-liner:

```bash
claude mcp add-json slm-gate '{
  "command": "node",
  "args": ["/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"],
  "env": {
    "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
    "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
    "NUM_CTX": "4096"
  }
}'
```

Alternatively, create or edit `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": ["/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"],
      "env": {
        "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
        "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
        "NUM_CTX": "4096"
      }
    }
  }
}
```

**Layer 2 (optional — send Claude Code's model requests through `llm-gate`):** add the address to `~/.claude/settings.json`. Note there is **no `/v1`** at the end; Claude Code adds it itself.
```json
{ "env": { "ANTHROPIC_BASE_URL": "http://localhost:8787" } }
```
In the VS Code extension, set it in your VS Code user settings instead:
```json
"claudeCode.environmentVariables": [{ "name": "ANTHROPIC_BASE_URL", "value": "http://localhost:8787" }]
```
Your claude.ai login or API key keeps working. The model gate starts by itself the next time Claude Code starts `slm-gate`'s MCP server.

> _Note: behind any address other than Anthropic's, Claude Code stops using server-side MCP tool search (set `ENABLE_TOOL_SEARCH=true` to turn it back on), and Remote Control and server-managed settings are not available. The Claude desktop app's Code tab ignores this setting._

See the full config reference: [`configs/claude-code/README.md`](configs/claude-code/README.md)

---

**Claude Desktop** (the Anthropic desktop app):

**File to edit:**
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": ["/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"],
      "env": {
        "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
        "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
        "NUM_CTX": "4096"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

> **Claude Desktop starts MCP servers from a working directory that does not exist.** Leave `LEDGER_PATH` blank in your `.env`, or set it to the full path on your machine. A relative path such as `./output/ledger.sqlite` makes the server fail on startup with `ENOENT: mkdir './output'`. See [Ledger Path Must Be a Full Path on Your Machine](#ledger-path-must-be-a-full-path-on-your-machine).

See the full config reference: [`configs/claude-desktop/README.md`](configs/claude-desktop/README.md)

---

#### Cursor

Create or edit the file `.cursor/mcp.json` in your project workspace root:

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": ["/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"],
      "env": {
        "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
        "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
        "NUM_CTX": "4096"
      }
    }
  }
}
```

**Layer 2 is not possible in Cursor.** Cursor sends every model request through its own servers first, even with "Override OpenAI Base URL" set, and those servers can't reach `localhost`. Layer 1 works as above.

See the full config reference: [`configs/cursor/README.md`](configs/cursor/README.md)

---

#### VS Code Extensions: Cline & Continue

Both Cline and Continue are AI coding extensions for VS Code and JetBrains that support custom MCP servers and full provider flexibility.

**Cline** — edit `cline_mcp.json` (usually at `~/.cline/cline_mcp.json` or in your project root):

```json
{
  "mcpServers": {
    "slm-gate": {
      "command": "node",
      "args": ["/Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js"],
      "env": {
        "SLM_BRAIN_MODEL": "qwen2.5-coder:3b",
        "SLM_GATE_MODEL": "qwen2.5-coder:0.5b",
        "NUM_CTX": "4096"
      }
    }
  }
}
```

**Continue** — edit `.continue/config.yaml` in your project root or home directory:

```yaml
mcpServers:
  - name: slm-gate
    command: node
    args:
      - /Users/yourname/projects/small-language-model-gate/dist/mcp-gate/index.js
    env:
      SLM_BRAIN_MODEL: "qwen2.5-coder:3b"
      SLM_GATE_MODEL: "qwen2.5-coder:0.5b"
      NUM_CTX: "4096"
```

**Layer 2 (optional — send their model requests through `llm-gate`, with your own API key):**
- **Cline / Roo Code:** Settings → API Provider **Anthropic** → tick **Use custom base URL** → `http://localhost:8787`.
- **Continue:** in `config.yaml`, on the model: `provider: anthropic` and `apiBase: http://localhost:8787/v1/` (for OpenAI models: `provider: openai`, `apiBase: http://localhost:8787/v1`).

Models bundled with Cline's or Continue's own subscription can't be redirected. `slm-gate doctor` prints these lines with your current port.

See the full config reference: [`configs/cline-continue-opencode/README.md`](configs/cline-continue-opencode/README.md)

---

#### Codex, Gemini CLI & Other Tools (Layer 2)

Add `slm-gate` as an MCP server in the tool (see its MCP documentation; the JSON is the same as above), so the model gate starts with the tool. Then point the tool's model address at the gate:

**Codex** (CLI and IDE extension share `~/.codex/config.toml`). Your ChatGPT login or API key keeps working:
```toml
model_provider = "slm-gate"

[model_providers.slm-gate]
name = "slm-gate"
base_url = "http://localhost:8787/v1"
requires_openai_auth = true
```
Don't set `supports_websockets`: over a WebSocket Codex sends only the newest part of the conversation, so the gate can't see or shrink the rest.

**Gemini CLI** (API key only; a Google-account login ignores the address setting):
```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:8787
export GEMINI_API_KEY=<your key>
```
and in `~/.gemini/settings.json`: `{ "security": { "auth": { "selectedType": "gemini-api-key" } } }`. For the Antigravity CLI (`agy`), set the same two variables and `{ "modelProvider": "gemini" }` in `~/.gemini/antigravity-cli/settings.json`.

**OpenCode, Kilo Code, Zed, Copilot Custom Endpoint, Junie CLI, Aider:** run `slm-gate doctor`. It prints the exact setting for each tool with your current port. Copy it from there rather than guessing: each tool wants the address in a slightly different form (with or without `/v1`, or the full `/v1/messages` path).

---

### ✅ You're Set Up! What's Next?

With your editor wired up, proceed to **[Section 5: Configuration Setup Guide](#5-configuration-setup-guide)** to create your `.env` file with the right settings for your machine — starting from the 16 GB preset.

---

## 5. Configuration Setup Guide

`slm-gate` is configured through a `.env` file — a plain text file in the root of the repository that holds your settings. Think of it as a control panel with clearly labelled switches.

### Quick Start: Copy Your RAM Preset

Instead of starting from scratch, find your machine's RAM in the table below and copy the matching preset file for your editor. These are fully commented templates with sensible defaults already filled in.

> **Using 16 GB RAM?** That's the baseline configuration used throughout this guide. Copy the preset for your editor and you're most of the way there.

#### All Configuration Preset Files

| Editor / Client | 16 GB RAM | 24 GB RAM | 32 GB RAM |
| :--- | :--- | :--- | :--- |
| **Google Antigravity** | [`.env.16gb.example`](configs/antigravity/.env.16gb.example) | [`.env.24gb.example`](configs/antigravity/.env.24gb.example) | [`.env.32gb.example`](configs/antigravity/.env.32gb.example) |
| **Claude Code** | [`.env.16gb.example`](configs/claude-code/.env.16gb.example) | [`.env.24gb.example`](configs/claude-code/.env.24gb.example) | [`.env.32gb.example`](configs/claude-code/.env.32gb.example) |
| **Claude Desktop** | [`.env.16gb.example`](configs/claude-desktop/.env.16gb.example) | [`.env.24gb.example`](configs/claude-desktop/.env.24gb.example) | [`.env.32gb.example`](configs/claude-desktop/.env.32gb.example) |
| **Cursor** | [`.env.16gb.example`](configs/cursor/.env.16gb.example) | [`.env.24gb.example`](configs/cursor/.env.24gb.example) | [`.env.32gb.example`](configs/cursor/.env.32gb.example) |
| **Cline / Continue** | [`.env.16gb.example`](configs/cline-continue-opencode/.env.16gb.example) | [`.env.24gb.example`](configs/cline-continue-opencode/.env.24gb.example) | [`.env.32gb.example`](configs/cline-continue-opencode/.env.32gb.example) |
| **Generic Stdio** | [`.env.16gb.example`](configs/generic-stdio/.env.16gb.example) | [`.env.24gb.example`](configs/generic-stdio/.env.24gb.example) | [`.env.32gb.example`](configs/generic-stdio/.env.32gb.example) |
| **Generic HTTP** | [`.env.16gb.example`](configs/generic-http/.env.16gb.example) | [`.env.24gb.example`](configs/generic-http/.env.24gb.example) | [`.env.32gb.example`](configs/generic-http/.env.32gb.example) |
| **Full Reference** | [`.env.example`](.env.example) (all variables, fully documented) | | |

Each preset holds every setting from `.env.example`, with the models and sizes for that amount of RAM. Copy the one for your tool and RAM to `.env` in the `slm-gate` folder.

> **Note for Antigravity users:** values in the `"env"` block of `~/.gemini/config/mcp_config.json` apply to `slm-gate`'s MCP server inside Antigravity and override `.env` there. The model gate reads only `slm-gate`'s `.env`, so keep the model settings the same in both places.

### The 16 GB Baseline Configuration

Here is a minimal, working `.env` for a 16 GB machine. Copy this to a file named `.env` in your repository root and fill in the blanks:

```bash
# ── Local AI Models ────────────────────────────────────────────────────────
SLM_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_KEEP_ALIVE=12h
SLM_BRAIN_MODEL=qwen2.5-coder:3b        # The smarter local model (heavier tasks)
SLM_GATE_MODEL=qwen2.5-coder:0.5b      # The tiny router model (instant decisions)
NUM_CTX=4096                             # Context window — keep at 4096 for 16 GB
TEMPERATURE=0

# ── Verifier ───────────────────────────────────────────────────────────────
STRICTNESS_LEVELS=0,1,2,3,4,5
HEADLINE_STRICTNESS=4

# ── API model (optional: benchmark and resolver cloud tier only) ──────────
CLOUD_API_STYLE=anthropic               # or: openai
CLOUD_BASE_URL=
CLOUD_API_KEY=                          # Leave blank unless you run `slm-gate bench`
CLOUD_MODEL=

# ── Servers ────────────────────────────────────────────────────────────────
LLM_GATE_PORT=8787
LLM_GATE_AUTOSTART=on                   # The MCP server starts the model gate for you
MCP_GATE_TRANSPORT=stdio
DOWNSTREAM_MCP=                         # Leave blank for standalone; set to TLS config for downstream

# ── Ledger & Telemetry ─────────────────────────────────────────────────────
LEDGER_PATH=/Users/yourname/projects/small-language-model-gate/output/ledger.sqlite   # Full path on YOUR machine — see the section below
LANGFUSE_PUBLIC_KEY=                    # Optional — leave blank if not using Langfuse
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=https://cloud.langfuse.com

# ── Subscription Plan (for quota metrics display) ─────────────────────────
SUBSCRIPTION_PLAN=claude-pro            # Set this to match your actual plan

# ── ⚠️ Window Budgets (REQUIRED for the Cycle cards — set all three) ──
# Estimates within a margin of error: providers don't publish these. See the reference below.
CLAUDE_WINDOW_BUDGET=460000             # tokens per 5-hour window (Claude Pro, estimate)
CHATGPT_WINDOW_BUDGET=160               # messages per 3-hour window (ChatGPT Plus, estimate)
GEMINI_WINDOW_BUDGET=500000             # tokens per 5-hour window (Gemini AI Pro, estimate)

# ── RAM Preset ────────────────────────────────────────────────────────────
RAM_PRESET=ram-16
TLS_ADAPTER=off                         # Set to 'on' only if using Tech-Lead-Stack downstream
```

---

### Ledger Path Must Be a Full Path on Your Machine

`LEDGER_PATH` is where `slm-gate` writes its local SQLite ledger. It must be the **full path on your machine**, starting from the root of your disk — never a path relative to the repository.

```bash
# macOS / Linux
LEDGER_PATH=/Users/yourname/projects/small-language-model-gate/output/ledger.sqlite

# Windows
LEDGER_PATH=C:\Users\yourname\projects\small-language-model-gate\output\ledger.sqlite
```

To get the value for your machine, run `pwd` inside the repository folder and append `/output/ledger.sqlite`.

**Why this matters.** Your editor or MCP host launches `slm-gate` as a background process, and the folder it launches *from* is not your repository. Claude Desktop, for example, starts MCP servers from a working directory that does not exist at all. A relative value such as `./output/ledger.sqlite` is resolved against that folder, so the server fails on startup with:

```text
Error: ENOENT: no such file or directory, mkdir './output'
```

The same relative path works from a terminal inside the repository, which is why it can look fine in one place and fail in the app.

Two rules follow from this:

- **Leaving `LEDGER_PATH` blank is safe.** A blank value means "use the default", which is `output/ledger.sqlite` under the folder where you installed `slm-gate`, already resolved to a full path.
- **If you set it, set the full path.** `pnpm run dev doctor` reports an issue for any value that is not a full path.

If you also run CLI commands such as `pnpm run slm-gate metrics` from a terminal, both the MCP server and the CLI read this same `.env`, so they land on the same file. If your host's config `env` block sets `LEDGER_PATH` directly, use the same full path there.

---

### Configuration Setting Reference

Every setting `slm-gate` reads is explained below in plain English. Settings are grouped in the order they matter most during setup.

#### Local Model (SLM) Settings

- **`SLM_PROVIDER`** — Where your local AI comes from. `ollama` runs it on your machine for free (the normal choice). `openai` redirects it to a cheap hosted model instead — useful if your machine can't run a local AI.
- **`OLLAMA_HOST`** — The address where Ollama is listening. Only change this if you're running Ollama on a different machine or port. Must be a full URL including `http://`. Default: `http://localhost:11434`
  - Note: Ollama's **own** `OLLAMA_HOST` variable, the one its docs and `ollama serve` use, is a bare `host:port` such as `127.0.0.1:11434`. `slm-gate` reads the same variable name but needs the scheme in front. If you have Ollama's form exported in your shell, set `slm-gate`'s value explicitly in its `.env` so the exported one doesn't reach it.
- **`OLLAMA_KEEP_ALIVE`** — How long a loaded model stays in memory after use. Keeping it loaded means instant responses next time; lowering it frees memory. Default: `12h`
- **`SLM_BRAIN_MODEL`** — The name of your smarter local model, used for compression, summarisation, and local resolution of harder tasks.
- **`SLM_GATE_MODEL`** — The name of your tiny, fast local model, used only for routing decisions ("can I handle this locally?"). Speed is the priority here.
- **`SLM_GATE_TESTING_MODEL`** — Only used when running the benchmarking harness. Ignore for everyday use.
- **`NUM_CTX`** — The maximum amount of text the local model can consider in a single request, measured in tokens (roughly ¾ of a word per token). Larger values allow the model to consider more context at once, but use significantly more memory. Default: `8192` — reduce to `4096` for 16 GB machines.
- **`TEMPERATURE`** — How creative or random the local model's responses are. `0` means fully deterministic (always the same answer for the same input). Keep this at `0` — this tool needs consistent, repeatable decisions. Default: `0`
- **`SLM_TIMEOUT_MS`** — How long to wait for the local model to respond before giving up and escalating to the cloud. Increase if you have a slow machine. Default: `120000` (2 minutes)
- **`SELF_CONSISTENCY_K`** — When double-checking a local answer, how many times to silently re-ask the question. If all answers agree, the result is trusted. If they disagree, the request escalates to the cloud. Default: `3`
- **`SELF_CONSISTENCY_TEMP`** — The randomness used during those re-checks. A small amount of randomness is intentional — if the model gives the same answer even when nudged to vary, that's a strong signal it's correct. Default: `0.7`

#### Verifier Strictness

After the local AI answers, a "verifier" grades whether the answer is good enough to trust. These control how strict that grading is.

- **`STRICTNESS_LEVELS`** — The available grading levels, from `0` (very lenient) to `5` (extremely strict). Leave this as-is. Default: `0,1,2,3,4,5`
- **`HEADLINE_STRICTNESS`** — The grading level actually in use. Higher means more local answers get escalated to the cloud (safer, higher quality, but costs more quota). Lower means more trust in local answers (saves more, but higher risk of lower quality). Default: `4`

#### API Model (Optional) & Semantic Cache

The model gate doesn't use the `CLOUD_*` settings: it sends each request on with your coding tool's own login. They are read only by the benchmark (`slm-gate bench`), the resolver's cloud tier (`RESOLVER_CLOUD_TIER`) and `SLM_PROVIDER=openai`.

- **`CLOUD_API_STYLE`** — Which API format that provider uses: `openai` or `anthropic`.
- **`CLOUD_BASE_URL`** — The address of that provider's API.
- **`CLOUD_API_KEY`** — The API key for it. Leave blank unless you use one of the three features above.
- **`CLOUD_MODEL`** — The exact model name.
- **`SEMCACHE`** — Turns on "answer reuse." When enabled, identical read-only questions are answered from memory instead of making a new cloud call. Off by default. (`on` / `off`)
- **`SEMCACHE_THRESHOLD`** — How similar two questions must be before the old answer is reused. `0.95` is very strict. Default: `0.95`
- **`EMBED_MODEL`** — The local model used to measure question similarity. Default: `nomic-embed-text`

#### Server Ports & Downstream MCP

- **`LLM_GATE_PORT`** — The port the model gate (`llm-gate`) listens on. Only change it if another program uses this port; then run `slm-gate restart`, and `slm-gate doctor` to get the new line for each coding tool. Set it only in `slm-gate`'s `.env`: a value in a tool's MCP `env` block or your shell is ignored when finding and starting the model gate. Default: `8787`
- **`LLM_GATE_AUTOSTART`** — When a coding tool starts `slm-gate`'s MCP server, also start the model gate in the background if it isn't running, and bring it back within a minute if it stops. `off` means you start it yourself with `slm-gate start`. Default: `on`
- **`LLM_GATE_DISTILL`** — Shrink large command, search and listing output before a request leaves your machine. `off` makes the gate pass requests on unchanged. Default: `on`
- **`LLM_GATE_LOCAL_FIRST`** — Let the local model try the first message of each conversation (never slash commands, never coding tasks that need the tool's own tools). Default: `on`
- **`LOCAL_ATTEMPT_BUDGET_MS`** — How long that first message may wait for a local answer before it goes on to your provider. Default: `6000`
- **`UPSTREAM_ANTHROPIC_URL`**, **`UPSTREAM_OPENAI_URL`**, **`UPSTREAM_CHATGPT_URL`**, **`UPSTREAM_GEMINI_URL`** (optional) — Where the model gate sends each kind of request.

  You don't need to fill any of these, whether you use a subscription or an API key. Leave all four blank. The gate already knows where each request goes and uses the correct address automatically.

  The only reason to set one: your company makes all AI traffic go through its own proxy server. Then you would put that proxy's address in the matching line. Everyone else leaves them blank.

  These four are split by provider, not by subscription vs API. Here is which one each login uses:

  | Setting | Subscription login | API key | Default address |
  |---|---|---|---|
  | `UPSTREAM_ANTHROPIC_URL` | Claude Pro/Max in Claude Code | Anthropic API key (Claude Code, Cline and others) | `https://api.anthropic.com` |
  | `UPSTREAM_OPENAI_URL` | — | OpenAI API key (Codex, Cline and others) | `https://api.openai.com/v1` |
  | `UPSTREAM_CHATGPT_URL` | ChatGPT login in Codex | — | `https://chatgpt.com/backend-api/codex` |
  | `UPSTREAM_GEMINI_URL` | — (a Google-account login can't go through the gate) | Gemini API key (Gemini CLI, `agy`) | `https://generativelanguage.googleapis.com` |

  Your coding tool's own login (subscription or API key) is sent either way.
- **`DOWNSTREAM_MCP`** — If you want `mcp-gate` to sit in front of another MCP server (like Tech-Lead-Stack), put that server's launch command here as a JSON string. Ships blank, which is standalone mode; any file path inside the JSON must also be a full path on your machine.
- **`MCP_GATE_TRANSPORT`** — How `mcp-gate` communicates with your editor: `stdio` (your editor launches it directly) or `http` (network connection). Most setups use `stdio`. Default: `stdio`
- **`MCP_GATE_PORT`** — The port for HTTP mode only. Default: `8788`

#### Ledger & Telemetry

- **`LEDGER_PATH`** — Where the local database file is stored. This is what `pnpm run slm-gate metrics` reads from. Blank = `output/ledger.sqlite` under the install folder (already a full path). If you set it, it **must be a full path on your machine**, never one relative to the repository — see [Ledger Path Must Be a Full Path on Your Machine](#ledger-path-must-be-a-full-path-on-your-machine). `doctor` reports an issue for a relative value.
- **`PROVIDER`** — The cloud provider your IDE sends traffic to (`gemini`, `claude`, or `chatgpt`). Used for per-provider cycle extension metrics when the inbound request carries no recognizable model string. Not the same as `SLM_PROVIDER`. Default: `gemini`.
- **`LANGFUSE_PUBLIC_KEY`**, **`LANGFUSE_SECRET_KEY`**, **`LANGFUSE_HOST`** — Optional Langfuse connection. Fill these in only if you're using Langfuse for visual dashboards. Leave blank otherwise.
- **`SUBSCRIPTION_PLAN`** — Tells the metrics dashboard which plan you're on, so it can calculate how much subscription runway you've reclaimed. Valid values: `claude-pro`, `claude-max-5x`, `claude-max-20x`, `chatgpt-go`, `chatgpt-plus`, `chatgpt-pro-5x`, `chatgpt-pro-20x`, `gemini-plus`, `gemini-pro`, `gemini-ultra`. It sets the window *length* only, not the budgets below.
- **`CLAUDE_WINDOW_BUDGET`**, **`CHATGPT_WINDOW_BUDGET`**, **`GEMINI_WINDOW_BUDGET`** — ⚠️ **Required for the per-provider "Cycle" dashboard cards** (each provider has two: *Est. Seconds Saved (per prompt)* and *Est. Minutes Saved (total)*). How much your plan allows per usage window: *tokens* for Claude and Gemini, *messages* for ChatGPT. Set all three, whichever provider you use. If one is blank, both of that provider's cards stay empty. **These values, and the minutes they produce, are estimates within a margin of error:** Anthropic, OpenAI and Google don't publish them, only multipliers such as "Max 5x = 5× Pro".

  | Provider | Unit | Estimates by plan | Where the number comes from |
  |---|---|---|---|
  | Claude | tokens / 5 h | Pro ~460,000 · Max 5x ~2,300,000 · Max 20x ~9,200,000 | Max 5x measured 2026-09-16 (tokens sent ÷ `/usage` session share); Pro and 20x scaled by Anthropic's multipliers |
  | ChatGPT | messages / 3 h | Plus ~160 | Third-party reports, 2026 |
  | Gemini | tokens / 5 h | AI Pro ~500,000 · Ultra ~10,000,000 | Best guess: AI Pro assumed close to Claude Pro; Ultra is 20× AI Pro per Google |

  For a better number for your own account, divide the tokens you sent in a window by the share of the window used (Claude Code shows it in `/usage`). For Claude and Gemini, every token saved counts, including tool results shrunk by the MCP server. ChatGPT caps messages, so its window is only extended by prompts answered fully by the local model (`llm-gate`). Restart the gate after changing these. `slm-gate doctor` lists any that are missing.

#### Context Trimming & Safe Recovery

When a tool response is very large, `slm-gate` compresses it and keeps only the essential parts. The original is stashed locally so the AI can retrieve any trimmed content cheaply on demand.

- **`DISTILL_MIN_TOKENS`** — Responses smaller than this (in tokens) are passed through untouched — they're too small to be worth compressing. **500 tokens ≈ ~50 lines of code.** Default: `500`
- **`DISTILL_BUDGET_MS`** — How long the model gate may hold one request while it shrinks that request's new tool output. Past it, the output is sent as it was (and stays that way for the rest of the conversation). Default: `3000`
- **`DISTILL_MAX_TOKENS`** — The maximum size a response can be after compression. Anything still over this limit after compression gets trimmed, and a retrieval marker is inserted so the AI can ask for the trimmed content. It is also the threshold at which the local model is asked to summarise at all, which in standalone mode is the only compression trigger there is. **2000 tokens ≈ ~200 lines of code.** Default: `2000`
- **`DISTILL_PRESERVE_PATH`** — Path to a file listing text patterns that must never be compressed or altered (e.g., specific code markers). Optional.
- **`DISTILL_PRESERVE_MODE`** — Whether your custom patterns are added to (`extend`) or replace (`replace`) the built-in protection list. Use `extend`. Default: `extend`
- **`KEEP_RECENT_TOOL_TURNS`** — How many of the most recent tool responses to always keep in full (never compress), because they're almost certainly still needed. Default: `2`
- **`ELISION_MAX_ENTRIES`** — Maximum number of original (pre-compression) responses stored in the local recovery cache. Default: `5000`
- **`ELISION_RETENTION_DAYS`** — How long a stored original is kept before automatic cleanup. Default: `180` days
- **`ELISION_MAX_MB`** — Total disk space budget for the recovery cache. When exceeded, the oldest entries are deleted first. Default: `500 MB`

#### Advanced: Routing Tuner & Misc

- **`ROUTING_TUNE`** — When `on`, the gate learns from past results which types of requests the local model handles well, and routes those directly to cloud for request types where it usually fails. (`on` / `off`)
- **`ROUTING_TUNE_WINDOW`** — How many recent requests (per type) to consider. Default: `20`
- **`ROUTING_TUNE_MIN_SAMPLES`** — Minimum sample count before the tuner acts on a category's success rate. Default: `8`
- **`ROUTING_TUNE_THRESHOLD`** — Success rate below which the gate stops trying local for that request type. Default: `0.5`
- **`ROUTING_TUNE_EXPLORE_RATE`** — How often to try local even for categories it's learned to skip — keeps it adapting to improvement. Default: `0.15`
- **`RESOLVER_CLOUD_TIER`** — When `on`, allows the local AI to make a small, budgeted cloud call when it hits a genuinely ambiguous decision. (`on` / `off`)
- **`RESOLVER_CLOUD_BUDGET_USD`** — Hard dollar cap on the above feature. Default: `0` (off until you set a budget)
- **`RAM_PRESET`** — A convenience toggle that auto-selects sensible model defaults based on your RAM: `ram-8`, `ram-16`, `ram-32`, or `custom`.
- **`TLS_ADAPTER`** — Enables special handling for Tech-Lead-Stack payloads. Set to `on` only if TLS is your downstream. (`on` / `off`)

---

## 6. Verification & Day-to-Day Use

### Run the Preflight Health Check

Before using `slm-gate` in anger, confirm everything is wired up correctly:

```bash
pnpm run dev doctor
# or: node dist/cli.js doctor
```

This checks:
- Node.js version
- Ollama is running, and every model your settings name is downloaded (each missing one with its `ollama pull` command)
- Your hardware and `NUM_CTX` fit the models
- Layer 1 config is valid
- **The model gate is running.** If it isn't, it says so loudly (every coding tool pointed at it can't reach its AI provider), names the program holding the port if there is one, and gives the fix

It then prints the exact line to paste into each coding tool, using your current port, and lists the tools that can't use Layer 2 and why.

Fix any warnings it flags before proceeding.

### The Model Gate: Starts by Itself, and What to Do When It Can't

You don't need to run anything each day. The first coding tool you open starts `slm-gate`'s MCP server, which starts the model gate and checks Ollama and your models. If something is wrong you get a desktop notification, and your AI assistant tells you at the start of its next reply.

What your assistant tells you is a **snapshot from when `slm-gate` started**, because an MCP server's instructions are fixed for the whole session and cannot be rewritten later. If you fix the problem mid-session, the assistant may still repeat it — it is told so, and told to believe you over the notice. The desktop notifications and `slm-gate doctor` are always live. A problem that might just be a slow moment is never reported until a second check, a minute later, finds it still there.

| What you see | What to do |
| :--- | :--- |
| **Port 8787 is used by another program** | Quit that program (`slm-gate doctor` names it), then run `slm-gate start`. Or move the gate: set `LLM_GATE_PORT` to a free port in `slm-gate`'s `.env`, run `slm-gate restart`, then run `slm-gate doctor` and paste the new lines into each coding tool. |
| **The model gate is not running and did not start** | Run `slm-gate start`. If it still fails, read `output/llm-gate.log` in the `slm-gate` folder. After updating `slm-gate`, or if the log shows a missing file, repair the install with `pnpm install && pnpm run build` in the `slm-gate` folder, then `slm-gate restart`. |
| **The model gate is running an older build** | Run `slm-gate restart` when no coding tool is in the middle of an answer. |
| **Ollama is not running** | Run the command the notification names — `slm-gate` picks it from how Ollama is installed here (`brew services start ollama`, `open -a Ollama`, `sudo systemctl start ollama` or `ollama serve`). Requests still reach the cloud meanwhile; nothing is answered or shrunk locally. |
| **Ollama did not answer** | Usually nothing. `slm-gate` gave up waiting rather than finding Ollama down, which mostly happens while everything is still starting. It only tells you at all if it is still true a minute later. If it keeps happening, run `slm-gate doctor`. |
| **`OLLAMA_HOST` is not an http address** | Set `OLLAMA_HOST` to a full URL, e.g. `http://localhost:11434`. Ollama's *own* `OLLAMA_HOST` variable is a bare `host:port`, so a value copied from Ollama's docs will not work here. |
| **Something is listening but it is not Ollama** | Another program holds port 11434, or `OLLAMA_HOST` points somewhere else. `slm-gate doctor` names what holds the port. |
| **A local model is not downloaded** | Run the `ollama pull …` command shown. |

`slm-gate stop` stops the model gate and keeps it stopped until `slm-gate start`, `slm-gate restart` or your next restart; coding tools pointed at it can't reach their provider meanwhile. `slm-gate serve` runs the model gate in the terminal instead (useful for watching its log).

### Checking a Coding Tool Through the Gate (Run Later)

`slm-gate` ships a live check for each coding tool. Each check makes the tool read `package.json` through the gate and reply with its name, which proves a full back-and-forth including a tool step. Run them whenever you install a tool or get an account:

```bash
pnpm exec tsx scripts/spike-check.ts --list                          # every check and its id
pnpm exec tsx scripts/spike-check.ts codex-chatgpt-login --gate      # one check, through the real model gate
pnpm exec tsx scripts/spike-check.ts --manual --gate                 # the IDE extensions: you send the prompt, it checks the result
```

- `--gate` runs the check through a separate, temporary model gate (its own port and throwaway ledger), so your running gate and your ledger are not touched.
- A check shows **SKIPPED**, not failed, when the tool isn't installed or the key it needs isn't set.
- **Codex with a ChatGPT login** (`codex-chatgpt-login`) matters most: how the gate recognises that login was worked out from Codex's source code and has never been run against a real ChatGPT login.

### Check Your Savings (Any Time)

```bash
pnpm run slm-gate metrics
```

Prints a live summary from your local ledger: tokens saved, compression ratio, local vs. cloud routing split, and subscription runway reclaimed. No internet required.

### Verify Active Compression in Your Editor

When your editor calls a tool (like `get_skill` in Tech-Lead-Stack), the response that arrives in your editor's context should be noticeably shorter than the raw output — but still contain all the critical content (headings marked `MUST`, YAML frontmatter, phase markers).

To see `slm-gate` working in real-time, check your editor's MCP logs for the string `[pipeline] distill`:

| Editor | How to View MCP Logs |
| :--- | :--- |
| **Antigravity** | Antigravity output/MCP tab |
| **Cursor** | Output panel → select "MCP" from dropdown |
| **Claude Desktop (macOS)** | `tail -f ~/Library/Logs/Claude/mcp*.log` |
| **Claude Desktop (Windows)** | `type "%APPDATA%\Claude\logs\mcp*.log"` |
| **Cline / VS Code** | VS Code Output panel → select "Cline" or your MCP server |
| **Claude Code** | Start with `--mcp-debug` flag for detailed terminal output |

### Cloud API Keys

Neither layer needs a `CLOUD_API_KEY`: the model gate sends each request on with your coding tool's own login. The `CLOUD_*` variables are only required if:
- You run the offline testing harness (`slm-gate bench`), or
- You turn on the resolver's cloud tier (`RESOLVER_CLOUD_TIER`), or use `SLM_PROVIDER=openai`

---

## 7. Architecture & Advanced Features

### Deep Dives

- **[Context Distillation and Elision](./docs/architecture/context-distillation-and-elision.md):** How `slm-gate` safely drops old tool outputs to save tokens, and how the elision cache allows cheap recovery of trimmed content.

### No-Ollama / Hosted Small-Model Fallback

If your machine cannot run Ollama (for example, it doesn't meet the minimum RAM requirements), you can point the local model layer at a cheap, hosted small model instead:

```bash
SLM_PROVIDER=openai
OLLAMA_HOST=https://api.openai.com/v1  # or any OpenAI-compatible endpoint
SLM_BRAIN_MODEL=gpt-4.1-nano
SLM_GATE_MODEL=gpt-4.1-nano
```

> _Note: Because hosted "small" models still cost money and add network latency, the savings are lower than running locally. Token compression will still save cloud tokens, but local deferral savings will be minimal._

### Architectural Warning for Contributors

This project strictly uses **Native Structured Outputs** (`format: jsonSchema` / `response_format: { type: "json_schema" }`) for all deterministic logic. Do **not** use prompt engineering to request JSON in markdown blocks, and do not use regex extraction. On Apple Silicon (llama.cpp), models that don't emit proper stop tokens will ramble indefinitely and cause timeout failures.

---

## Intended Use

This software runs locally and drives third-party AI tools and models that **you** install and authenticate. You are responsible for complying with the terms of any tool, model, or subscription you connect to it. It is designed for single-user, local use with your own accounts — it does not proxy or share third-party credentials between users. Provided "as is" under the MIT License, without warranty of any kind.
