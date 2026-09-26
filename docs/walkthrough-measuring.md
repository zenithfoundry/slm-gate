# Walkthrough: Measuring Your Savings

> [!NOTE]
> **Is this guide for me?**
> This guide is for **EVERYONE**, whether you use an API key or a flat-fee subscription model. 
> 
> The tool keeps a local logbook (called the "ledger") of every request. This guide will show you how to read that logbook to compare your usage "with the gate on" versus "with the gate off."

### The Goal
We want to see fewer tokens and less quota used, WITHOUT the answers getting worse. 

### What you'll need before starting
- [x] The `llm-gate` or `mcp-gate` setup completed from the previous guides.
- [x] The project is built (you have run `pnpm run build`).

---

## Step 1: Collect a "Before" Sample (Gate OFF)

First, we need to gather a baseline of how many tokens you use normally without the gate's help.

**How to turn the gate OFF:**
- **If using a chat client (Cursor/Cline):** Remove the `http://localhost:8787/v1` Base URL from your settings to point back directly to the real API.
- **If using Claude Code:** Close your terminal and open a new one without the `ANTHROPIC_BASE_URL` export.
- **If using an advanced client that supports custom headers:** You can send the HTTP header `x-slm-route: raw` with your requests to force the gate to bypass the local model.
- **If using the MCP Gate (Layer 1):** Remove the MCP gate from your editor's config and point it back to the original tool server.

**Do 10 normal tasks:**
Use your client to do about 10 tasks that you would typically do in your day-to-day work (e.g., refactoring a file, asking for an explanation, writing a test).

*What just happened: You generated real-world traffic that bypassed the local SLM, logging the pure "cloud-only" cost and token usage to your ledger.*

---

## Step 2: Collect an "After" Sample (Gate ON)

Now, we need to gather data with the gate actively protecting your quota.

**How to turn the gate ON:**
Restore the `http://localhost:8787/v1` Base URL in your client settings, or restore the MCP gate in your editor configuration.

**Do 10 more tasks:**
Perform 10 *similar* tasks to the ones you did in Step 1. They don't have to be identical, but they should be of similar complexity.

*What just happened: You generated traffic that was intercepted by the local SLM, logging the new, optimized token usage and cost to the ledger.*

---

## Step 3: Read the Results

Now let's compare the "Before" and "After" data.

Open your terminal and run the metrics command:
```bash
npx slm-gate metrics
```

**What you should see:**
```text
--- Local SQLite Ledger Metrics ---
┌─────────┬──────────────────────────┬────────────┬────────┬─────────────┬───────┐
│ (index) │ Arm                      │ Cost (USD) │ Tokens │ Avg Quality │ Count │
├─────────┼──────────────────────────┼────────────┼────────┼─────────────┼───────┤
│ 0       │ slm_gate=off (Baseline)  │ 0.1500     │ 45000  │ 0.95        │ 10    │
│ 1       │ slm_gate=on (Router)     │ 0.0300     │ 9000   │ 0.95        │ 10    │
└─────────┴──────────────────────────┴────────────┴────────┴─────────────┴───────┘

--- Deltas (on - off) ---
Cost Saved: $0.1200
Tokens Saved: 36000
Quality Change: +0.00
```

**How to read this table:**
- **Cost (USD):** The actual money spent. **Note for subscription users:** Since you pay a flat monthly fee, this column will be near zero ($0.00). This is expected!
- **Tokens:** The total number of tokens sent to and received from the cloud. **For subscription users, this is the number that matters.** Saving tokens means you are staying under your rate limits and preventing your quota from running out.
- **Avg Quality:** A score of how good the answers were.
- **What "Good" looks like:** You want to see **Tokens** drop significantly, while **Avg Quality** stays the same or goes up.

*What just happened: The metrics command analyzed the SQLite ledger and aggregated the rows into a simple before/after comparison.*

---

## Optional: Advanced Offline Evaluation (API-Key Only)

If you have a paid API key set in `CLOUD_API_KEY`, you can run a simulated batch test without having to manually do 20 tasks.

Run the bench command:
```bash
npx slm-gate bench --n 10
```

This runs 10 offline dataset tasks against both the local and cloud models and outputs two files:
1. `output/leaderboard.md`: A detailed breakdown of which model answered which question.
2. `output/deferral_curve.svg`: A chart showing the router's performance. 

**How to read the deferral curve:**
Open the SVG file in your browser. The chart shows cost on the X-axis and quality on the Y-axis. The router's dot (the performance of `slm-gate`) should sit above the diagonal "random routing" line, meaning it is making smart decisions. If the "small-model-only" baseline is at the exact same quality as the "big-model-only" baseline, your test tasks were too easy! 

For deeper analysis, read `harness/README.md`.

---

## Optional: Syncing with Langfuse Cloud

If you have configured Langfuse Cloud, you can synchronize all historical local ledger records and quantitative scores to your online dashboard:

```bash
# Preview what will be synced
pnpm run slm-gate ledger:sync --dry-run

# Synchronize all records to Langfuse Cloud
pnpm run slm-gate ledger:sync --all
```

For the complete, beginner-to-advanced guide detailing how to build custom ROI dashboards and configure model pricing in Langfuse, see [`docs/analytics-and-observability.md`](./analytics-and-observability.md).

---

## Troubleshooting

- **"The table is empty" or "Count is 0":** You haven't done any tasks yet, or you are pointing at the wrong ledger path. Check your `LEDGER_PATH` in `.env`.
- **"Quality went down!":** The local model is answering questions it shouldn't. You need to tell it to be more strict and *escalate* more often. Open your `.env` file and raise the `HEADLINE_STRICTNESS` setting (e.g., from 4 to 5). This makes the verifier more skeptical of the local model's answers.
- **For more troubleshooting:** Check the FAQ section in [`docs/analytics-and-observability.md`](./analytics-and-observability.md#9-troubleshooting--frequently-asked-questions).

