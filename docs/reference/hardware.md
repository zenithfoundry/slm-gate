# Hardware

Which local models fit your RAM, how Ollama uses memory, and the Ollama settings that keep both models loaded.

## What you need

- A Mac or Linux computer with **16 GB of RAM or more**. Windows is not supported.
- [Node.js 22 or newer](https://nodejs.org) (22, 24 and 26 are all supported; `node -v` shows yours). No compiler
  is needed: the one native dependency ships prebuilt binaries.
- [Ollama](https://ollama.com/download), running, at `http://localhost:11434`. `ollama list` shows it works.
- pnpm 10, only for a [git checkout](../source/setup.md).

Optional: [Langfuse](https://langfuse.com/) for a hosted dashboard, a [toolbox](../README.md#glossary) such as
Tech-Lead-Stack, and an API key only for the open-decisions step's optional cloud tier or a hosted small model.
The model gate forwards your coding tool's own login and needs no key.

## RAM by machine: model table

`slm-gate init` and `slm-gate doctor` read your RAM and use the row below: a size between two rows gets the
smaller row, and more than 128 GB gets `custom`, starting from the 128 GB models. The one table they, `config`
and `models:check` all read is `ramPresets` in `src/hardware.ts`. `SLM_BRAIN_MODEL` and `SLM_GATE_MODEL` in your
settings always win over `RAM_PRESET`.

| Your RAM | `RAM_PRESET` | Brain model | Gate model | Download (both) | `NUM_CTX` |
| :--- | :--- | :--- | :--- | :-- | :-- |
| **16 to 23 GB** | `ram-16` | `qwen3.5:2b` | `qwen2.5-coder:0.5b` | 2.3 GB | 4096 |
| **24 to 31 GB** | `ram-24` | `qwen3.5:4b` | `qwen3.5:2b` | 5.3 GB | 8192 |
| **32 to 47 GB** | `ram-32` | `qwen2.5:7b` | `qwen3.5:2b` | 6.6 GB | 8192 |
| **48 to 63 GB** | `ram-48` | `qwen3.5:9b` | `qwen3.5:2b` | 8.5 GB | 8192 |
| **64 to 127 GB** | `ram-64` | `qwen3.5:9b` | `qwen3.5:4b` | 10.0 GB | 8192 |
| **128 GB** | `ram-128` | `qwen3:14b` | `qwen3:8b` | 14.5 GB | 8192 |
| **More than 128 GB** | `custom` | starts from `qwen3:14b` | starts from `qwen3:8b` | 14.5 GB | 8192 |

**The two models.** The [gate model](../README.md#glossary) is small and fast: it shrinks tool output and rates
the risk of an answer to an open decision. The [brain model](../README.md#glossary) is larger: it folds the
conversation memory, checks shortened skill text under the fidelity guard, answers `ask_elision` questions and
settles open decisions. Neither answers your prompts; your AI provider still does that.

No third model is needed unless you turn on `DISTILL_ADAPTIVE` or `SEMCACHE`
([Settings](settings.md#shrinking-tool-output)); then `ollama pull nomic-embed-text` (under 300 MB).

> **Models that fit your exact computer better:** [llmfit](https://github.com/AlexsJones/llmfit) measures your
> RAM, GPU and speed and ranks the models that run best on them. `slm-gate` keeps two models loaded and needs
> replies within seconds, so choose ones llmfit rates as a good fit with plenty of tokens per second, not simply
> the largest that fits. Put them in `SLM_BRAIN_MODEL` and `SLM_GATE_MODEL`.
>
> ```bash
> brew install AlexsJones/llmfit/llmfit    # macOS or Linux with Homebrew
> llmfit fit --perfect -n 5                # the best fits for this computer
> llmfit --ram=48G fit --perfect -n 5      # for a computer with 48 GB
> ```

`slm-gate models:check` reads the models your settings name, works out their memory footprint and says whether
they fit next to your other apps.

## Memory maths

```text
Total memory used = model weights + (NUM_CTX × KV cache per token) × models loaded
```

The bigger the models and the larger `NUM_CTX`, the more RAM is used, for both models at once. If your computer
feels sluggish after starting `slm-gate`, or models keep unloading:

1. **Lower `NUM_CTX` first.** Halving it (8192 to 4096) saves more memory than switching to a smaller model.
   The KV cache grows with it: roughly 2 to 3 GB per 32k tokens for a 4B model, more for bigger ones.
   `ollama ps` shows the context each loaded model actually got.
2. **Then a smaller brain model.** Drop one row in the table above.
3. **Do not drop to one Ollama slot** while `SLM_PIN_MODELS=on`: the gate would keep reloading its missing
   model and Ollama would keep evicting the other. If you must run with `OLLAMA_MAX_LOADED_MODELS=1`, set
   `SLM_PIN_MODELS=off` too, and accept a reload every time the two models take turns.

Then `slm-gate restart` and `slm-gate doctor`. Pull any new model first: `ollama pull <model>`.

## Keep both models loaded

`slm-gate` works with its two models as a pair on every request. Ollama's slot count should be exactly 2,
and the context Ollama gives a model should match `NUM_CTX`. These are Ollama's own settings; `slm-gate` does
not read them.

```bash
# macOS, from any terminal, for the running login session
launchctl setenv OLLAMA_MAX_LOADED_MODELS 2
# Linux, in the shell that starts `ollama serve`, or the systemd unit's environment
export OLLAMA_MAX_LOADED_MODELS=2
```

With `SLM_PIN_MODELS=on` (the default), the model gate checks every minute and, only when one of its models is
missing, unloads the stranger and warms its own back in. Check what is loaded with `ollama ps`, never with
`ollama run`, which loads the model you name and evicts one of the pair.

### macOS with Homebrew: the launch file

If you installed Ollama with Homebrew, `brew services restart ollama` **silently rewrites** its launch file,
`~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`, and drops any environment variables you added. Models are
then swapped in and out, replies get slow, and context is cut.

1. Stop the Homebrew-managed service: `brew services stop ollama`
2. Open the plist in a text editor and add the variables:
   ```xml
   <key>EnvironmentVariables</key>
   <dict>
     <key>OLLAMA_CONTEXT_LENGTH</key><string>8192</string>
     <key>OLLAMA_KEEP_ALIVE</key><string>12h</string>
     <key>OLLAMA_MAX_LOADED_MODELS</key><string>2</string>
   </dict>
   ```
   `OLLAMA_CONTEXT_LENGTH` should match `NUM_CTX`, and `OLLAMA_KEEP_ALIVE` should match the same setting in
   `slm-gate`'s settings file.
3. Load it without Homebrew: `launchctl load ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`

More in the [Ollama FAQ](https://docs.ollama.com/faq).

### Starting Ollama

How you start it depends on how you installed it. `slm-gate` works out which applies and names the right
command in any notification it shows.

```bash
brew services start ollama    # Homebrew: runs in the background from login
open -a Ollama                # the macOS app: a llama icon in the menu bar
sudo systemctl start ollama   # Linux, installed with the official script
ollama serve                  # a plain binary, or Linux without systemd
```

If `ollama serve` prints `address already in use`, Ollama is already running; that is not an error.

## More RAM

The local models only ever see a small window of text (`NUM_CTX`). More memory lets you raise two things: the
models' size (a brain in the 9B to 14B class) and the window (`NUM_CTX` 32k to 64k). Put the headroom into the
fidelity guard, decision memory and the repository index first ([proven profile](../npm/profiles.md)): a bigger
brain with a bigger window loses fewer sentences and answers more questions from your code.

Reading a whole coding-tool request locally is not a goal: a Claude Code request routinely runs 60k to 80k
tokens, and a local model takes a minute or more per turn to read one. The short conversation memory is the
right currency for a small model.

**No cloud model at all.** Ollama answers requests in Anthropic's own format, so Claude Code can be pointed
straight at it with `ANTHROPIC_BASE_URL=http://localhost:11434` and a local model name. On 24 GB this is a
demonstration: a 4B model cannot carry Claude Code's tool use. On 64 GB a 30B-class coding model with a 64k
window is a real local-only setup, and the MCP gate still earns its place in front of it by shrinking what that
local model has to read.

---

Next: [How it works](how-it-works.md)
