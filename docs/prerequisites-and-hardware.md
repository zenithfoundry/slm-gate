# Prerequisites & Hardware Sizing

## Required Software

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

## Optional Prerequisites

These are not required to get started, but unlock additional capabilities:

- **[Langfuse](https://langfuse.com/)** — A free, open-source web dashboard for visualising your AI usage and token savings. Self-hostable or use the cloud version. You only need this if you want richer visual analytics beyond the CLI metrics command.
- **Cloud API Key** — An `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or similar. Only needed if you plan to use Layer 2 (`llm-gate` for model endpoint routing) or run the offline benchmarking harness. For Layer 1 subscription users, no API key is needed.
- **[Tech-Lead-Stack](https://github.com/bronz3beard/ai.tech-lead-stack)** — An optional companion MCP server that `slm-gate` can sit in front of. See [How It Operates](integration-layers.md) for details.

---

## Machine Sizing & Hardware Recommendations

<a id="appendix-c-ram-by-machine-model-table"></a>

Choosing the right local AI model for your machine is the single most important setup decision. Too large a model and your computer will slow to a crawl; too small and the compression quality suffers.

### ⚡ Built-In Preflight Diagnostic Tools

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

### RAM-by-Machine Model Table

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

### Dual-Model Setup: Keeping Both Models Ready at Once

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

### 🍏 macOS + Homebrew Users: Avoid This Common Pitfall

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

### Memory Pressure Troubleshooting

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

[README](../README.md) · [All docs](README.md) · Next: [How It Operates: Choosing Your Integration Layer](integration-layers.md)
