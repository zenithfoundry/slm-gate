# Architecture & Advanced Features

## Deep Dives

- **[Context Distillation and Elision](./architecture/context-distillation-and-elision.md):** How `slm-gate` safely drops old tool outputs to save tokens, and how the elision cache allows cheap recovery of trimmed content.

## No-Ollama / Hosted Small-Model Fallback

If your machine cannot run Ollama (for example, it doesn't meet the minimum RAM requirements), you can point the local model layer at a cheap, hosted small model instead:

```bash
SLM_PROVIDER=openai
OLLAMA_HOST=https://api.openai.com/v1  # or any OpenAI-compatible endpoint
SLM_BRAIN_MODEL=gpt-4.1-nano
SLM_GATE_MODEL=gpt-4.1-nano
```

> _Note: Because hosted "small" models still cost money and add network latency, the savings are lower than running locally. Token compression will still save cloud tokens, but local deferral savings will be minimal._

## Architectural Warning for Contributors

This project strictly uses **Native Structured Outputs** (`format: jsonSchema` / `response_format: { type: "json_schema" }`) for all deterministic logic. Do **not** use prompt engineering to request JSON in markdown blocks, and do not use regex extraction. On Apple Silicon (llama.cpp), models that don't emit proper stop tokens will ramble indefinitely and cause timeout failures.

---

[README](../README.md) · [All docs](README.md)
