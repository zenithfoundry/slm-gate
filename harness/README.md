> [!IMPORTANT]
> **Do I even need this?**
>
> This harness is **OPTIONAL** and only useful if you have an API key for a paid model (what we call the "API cloud"). 
> 
> If you only use a subscription model inside your editor (like **Google AI Premium / Gemini Advanced**, **Claude Pro / Max / Team**, or **Cursor Pro / Teams**), **you cannot use this harness — skip it and use the live ledger instead** (see [Check Your Savings](../docs/daily-use.md#check-your-savings-any-time)). 
> 
> *Why?* The harness makes hundreds of its own automated calls, which requires an API key it can call directly. Your subscription model is locked inside your editor and can't be scripted against.

---

## What this actually measures

The harness answers **ONE** question: "is the router smart — does sending the hard tasks to the big model beat sending random tasks?" It helps you measure the quality of the router's decision-making. 

It does **NOT** measure your real-world savings; that is what the ledger is for.

| Tool | What it measures | Requirements | When it runs |
|---|---|---|---|
| **Harness** | Is the router smart (quality)? | Needs API cloud key | On demand |
| **Ledger** | Did I actually save money/quota? | Works on subscription too | Passively during normal use |

## The 30-second mental model

You have a **small local model (SLM)** that runs for free on your machine, and a **big paid model** in the cloud. 

When the local model isn't confident it can get an answer right, it **escalates** (hands the task) to the big model. Ideally, you want to escalate *only* the hard tasks to save money while keeping your accuracy high.

To see if this is working, we draw a **deferral curve**: we plot our accuracy against "what fraction of tasks we escalated," and compare our real router to a dumb baseline that just escalates random tasks. If the router beats the random baseline, it's genuinely picking the right tasks to escalate.

## The five "arms" explained like a bake-off

We run the same dataset of tasks through five different strategies (arms) to see who wins:

- **all_slm**: Only uses the small model (cheapest, but lowest accuracy).
- **armA**: Only uses the big model (most expensive, highest accuracy).
- **random_at_f**: A dumb baseline that escalates a random slice of tasks.
- **oracle_at_f**: A cheater that escalates *exactly* the ones the small model got wrong (the absolute best possible performance).
- **armB**: Your real router (the actual `llm-gate` logic).

**What does "good" look like?** `armB` should land **above** the `random_at_f` line and **below** the `oracle_at_f` line on the graph.

## Setup — step by step

**Prerequisites:**
1. Ollama is running and your testing model is pulled (e.g. `ollama pull qwen2.5-coder:3b` matching `SLM_GATE_TESTING_MODEL`).
2. A paid API key is in your `.env` file under the `CLOUD_*` variables.
3. The `llm-gate` server must be running.

**Flow:**
Open two terminals.

In Terminal 1, start the gate:
```bash
pnpm run llm-gate:serve
```

In Terminal 2, run the benchmark (we'll start small with 10 tasks):
```bash
pnpm run bench -- --n 10
```

When it finishes, a successful run prints:
```text
Wrote output/deferral_curve.svg
Wrote output/leaderboard.md
```
You can view the results in the `output/` folder!

## How to read your results

Check your `output/deferral_curve.svg` and `output/leaderboard.md` for two things:

1. **`armB` is above the random line** = Your router is smart! It's escalating the right tasks. If `armB` is exactly *on* the random line, the router is no better than a coin flip and bought you nothing.
2. **`all_slm` is below `armA`** = There are hard tasks in your dataset that were worth escalating. If `all_slm` and `armA` have the exact same accuracy, your test tasks are too easy and the curve proves nothing. Add harder tasks to your dataset!

## The cache, explained

Calling the cloud API is slow and costs real money. To fix this, answers are saved and reused from a cache.

- **Where it lives**: `harness/.cache/`
- **Safe to delete**: You can delete this folder at any time; the harness will just re-fetch the answers.
- **Model-aware**: The cache is tied to the specific model and prompt version that produced each answer. If you change your model in `.env`, the harness will automatically re-fetch the answers rather than improperly reusing the old model's work.

> [!CAUTION]
> **Cost warning**
> Running the harness spends real money on the API cloud (roughly N tasks worth of big-model calls the first time you run it). 
> 
> The `--n` flag controls how many tasks to run. Start small (e.g., `--n 10`) before running the full suite!

## Benchmark Model (`SLM_GATE_TESTING_MODEL`)

The benchmark harness tests local evaluation and routing under concurrency (`BATCH_SIZE=3`). To prevent local GPU/RAM memory contention and inference timeouts that can happen when running concurrent tasks against large reasoning models (such as `qwen3.5:9b`), the harness specifically evaluates using `SLM_GATE_TESTING_MODEL`.

- **Default**: Automatically defaults to match `SLM_GATE_MODEL` (e.g. `qwen2.5-coder:3b`).
- **Configuration**: Set explicitly in `.env`:
  ```bash
  SLM_GATE_TESTING_MODEL=qwen2.5-coder:3b
  ```
- **Cache invalidation**: The cache at `harness/.cache/` indexes answers by `SLM_GATE_TESTING_MODEL`. If you modify this variable or switch models, the harness automatically treats previous cache entries as stale and re-fetches cleanly.

## Langfuse Dashboard Configurations

### Evaluators
To measure quality (`task_pass`, `gates_satisfied`), configure these in the Langfuse UI:
1. Go to **Evaluators** -> **New Evaluator**.
2. Select **LLM-as-a-Judge** or **Deterministic** (depending on your setup).
3. For `task_pass`: Configure it to check if the final output contains a success indicator (or use an LLM prompt to grade).
4. For `gates_satisfied`: Configure it to verify that the required context was preserved by the gate.

### Monitors (Alerts)
To get alerts for regressions, configure these in the Langfuse UI under **Monitors**:
1. **Task Pass Drop Alert**: Trigger when `score_name="task_pass"` drops below `0.8`.
2. **Cost Spike Alert**: Trigger when `cost` per turn is unexpectedly high (e.g., `> 0.05`).

## Troubleshooting

- **"Only all_slm computed"**: You have no `CLOUD_*` key or model set in `.env`.
- **"Connection refused"**: The `llm-gate` server isn't running in another terminal.
- **"armB on the random line"**: Your router needs tuning. Adjust your `HEADLINE_STRICTNESS` in `.env`.
- **"Curve is flat / all_slm ≈ armA"**: Your dataset tasks are too easy.
