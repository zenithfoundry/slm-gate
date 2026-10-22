# Walkthrough: Measuring Your Savings

> [!NOTE]
> **Is this guide for me?**
> This guide is for **EVERYONE**, whether you use an API key or a flat-fee subscription model.
>
> The tool keeps a local logbook (called the "ledger") of every request. This guide shows you how to read that logbook: what each request would have cost without the gate, what it cost with it, and the difference.

### The Goal
We want to see fewer tokens and less quota used, WITHOUT the answers getting worse.

The gate never answers a request itself, so the answers come from the same model as before. What changes is the size of what reaches it. Every ledger row records the request before and after shrinking, so you do not need a separate "gate off" run: the comparison is inside each row.

### What you'll need before starting
- [x] The `llm-gate` or `mcp-gate` setup completed from the previous guides.
- [x] The project is built (you have run `pnpm run build`).

---

## Step 1: Do some normal work

Use your coding tool for about 10 tasks you would typically do in your day-to-day work (refactoring a file, asking for an explanation, writing a test, running the tests and fixing what fails). Tasks that run commands, search the code or list folders are the ones that produce large tool output, which is what the gate shrinks.

*What just happened: every model request your tool sent went through the gate, and every tool result your toolbox returned went through the MCP gate. Each one wrote a row to the ledger with the size before and after.*

---

## Step 2: Read the totals

Open your terminal and run the metrics command:
```bash
npx slm-gate metrics
```

**What you should see:**
```text
--- Local SQLite Ledger Metrics ---
┌─────────┬──────────────────────────────────┬────────────┬────────┬─────────────┬───────┐
│ (index) │ Rows                             │ Cost (USD) │ Tokens │ Avg Quality │ Count │
├─────────┼──────────────────────────────────┼────────────┼────────┼─────────────┼───────┤
│ 0       │ slm_gate=off (old benchmark rows)│ 0.0000     │ 0      │ 0.00        │ 0     │
│ 1       │ slm_gate=on (the gate)           │ 0.0000     │ 9000   │ 0.00        │ 24    │
└─────────┴──────────────────────────────────┴────────────┴────────┴─────────────┴───────┘
```

**How to read this table:**
- **Cost (USD):** Only the resolver's optional cloud call records a price. Your coding tool's own requests are billed to your subscription or key exactly as before, so this column is usually zero. That is expected.
- **Tokens:** The tokens the gate's rows recorded. For subscription users this is the number that matters: fewer tokens sent means you stay under your rate limits and your quota lasts longer.
- **slm_gate=off:** Rows written by the router benchmark that versions before 1.4 shipped. A fresh ledger has none.

---

## Step 3: Read the savings

The totals above do not say how much was saved. That is what the report and the dashboard are for.

```bash
pnpm run ledger:report
```

This prints tokens saved per day and all-time, from the ledger alone: for each row, the size before shrinking minus the size that went out. A day here equals the "Tokens Saved" card in Langfuse for the same UTC day.

```bash
pnpm run dashboard
```

This opens the local dashboard: minutes of each provider's usage window returned per cycle, tokens saved per provider and per week, the routing split (shrunk, sent unchanged), the tool definitions each request carried, and what shrinking a skill cost in requirement sentences (the fidelity card). [Analytics and observability](analytics-and-observability.md) explains each card.

**What "good" looks like:** `forward_compressed` rows with a clear gap between the size before and after, and a fidelity card that shows nothing lost. Rows that are all `forward_raw` mean nothing in those requests was large enough to shrink; that is normal for short conversations.

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
- **"Tokens saved is 0":** Nothing large enough to shrink has gone through yet (`DISTILL_MIN_TOKENS`), or your coding tool is not sending its model requests through the gate. `slm-gate doctor` prints the line to paste into each tool.
- **"A skill lost a sentence":** the fidelity card names it, and the guard protects that sentence by code on every later run. `pnpm run protections` lists what it has learned.
- **For more troubleshooting:** Check the FAQ section in [`docs/analytics-and-observability.md`](./analytics-and-observability.md#9-troubleshooting--frequently-asked-questions).
