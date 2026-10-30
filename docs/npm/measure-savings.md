# Measure your savings

How to read what the gate saved: the metrics command, the dashboard, Langfuse, and what the cycle cards mean.

The gate never answers a request itself, so your answers come from the same model as before. What changes is
the size of what reaches it. Every [ledger](../README.md#glossary) row records a request before and after
shrinking, so there is no separate "gate off" run to do: the comparison is inside each row.

## 1. Do some normal work

Use your coding tool for about ten tasks you would normally do. Tasks that run commands, search the code or list
folders produce the large tool output the gate shrinks. Every model request through the gate, and every tool
result through the MCP gate, writes a row with the size before and after.

## 2. Read the totals

```bash
slm-gate metrics
```

```text
--- Local SQLite Ledger Metrics ---
┌─────────┬──────────────────────────────────┬────────────┬────────┬─────────────┬───────┐
│ (index) │ Rows                             │ Cost (USD) │ Tokens │ Avg Quality │ Count │
├─────────┼──────────────────────────────────┼────────────┼────────┼─────────────┼───────┤
│ 0       │ slm_gate=off (old benchmark rows)│ 0.0000     │ 0      │ 0.00        │ 0     │
│ 1       │ slm_gate=on (the gate)           │ 0.0000     │ 9000   │ 0.00        │ 24    │
└─────────┴──────────────────────────────────┴────────────┴────────┴─────────────┴───────┘
```

- **Cost (USD):** only the open-decisions step's optional cloud call records a price. Your coding tool's own
  requests are billed to your subscription or key exactly as before, so this column is normally zero.
- **Tokens:** the tokens the gate's rows recorded. Fewer tokens sent means your usage window lasts longer.
- **slm_gate=off:** rows from a benchmark that versions before 1.4 shipped. A fresh ledger has none.

No internet is needed. The totals do not say how much was saved; that is what the dashboard is for.

## 3. The dashboard

The built-in dashboard reads the same ledger, with no cloud and no account. Today it runs from a git checkout of
the repository ([Set up from source: the dashboard](../source/setup.md#the-dashboard)), so it is a contributor
command for now; point it at your npm
install's ledger, `~/.slm-gate/output/ledger.sqlite`, with `LEDGER_PATH`. It shows:

- **Window time returned per cycle, per provider**: how many minutes of each provider's usage window you got
  back (a cycle is the window your first request opens; Claude: 5 hours), with average, median, a per-cycle
  table and a per-week chart.
- **Tokens saved per provider**, and the split of requests sent shrunk against sent unchanged.
- **Tool definitions in context per request**: how many tool schemas each request lists and how many stay
  deferred. A warning means the latest request listed many tools and deferred none: set `ENABLE_TOOL_SEARCH=true`
  next to `ANTHROPIC_BASE_URL` in Claude Code's settings.
- **Skill fidelity** (with `DISTILL_SKILLS=on`): the share of requirement sentences the brain model confirmed
  kept, how many skills went out unshrunk, and how many sentences are now protected by code.

Anything unmeasured shows as "not measured", never a fake zero. The maintainer's own dashboard is published at
[zenithfoundry.github.io/slm-gate](https://zenithfoundry.github.io/slm-gate/); anyone can drag their own
exported `data.json` onto it, and it renders in the browser and uploads nothing.

**What good looks like:** rows sent shrunk with a clear gap between the size before and after, and a fidelity
card that shows nothing lost. Rows all sent unchanged mean nothing in those requests was large enough to shrink
(`DISTILL_MIN_TOKENS`); that is normal for short conversations.

## What the cycle cards mean

Each provider has two cards: **Est. Seconds Saved (per prompt)** and **Est. Minutes Saved (total)**. Each
event's value is:

```text
estimated minutes saved = units saved × (window minutes ÷ window budget)
```

A card fills in only when there is traffic for that provider **and** the gate knows the window's budget. The
budget comes from your plan: set `SUBSCRIPTION_PLAN` (or `PLAN_CLAUDE`, `PLAN_CHATGPT`, `PLAN_GEMINI`) to the
plan you pay for, and the gate uses an estimate for it. A measured `CLAUDE_WINDOW_BUDGET`,
`CHATGPT_WINDOW_BUDGET` or `GEMINI_WINDOW_BUDGET` wins over the estimate. With no plan and no budget the cards
stay empty, and `slm-gate doctor` says so. **These minutes are estimates**: providers publish no figures, only
multipliers between plans. The plans, their estimates and how to measure your own:
[Settings: window budgets](../reference/settings.md#savings-figures).

ChatGPT meters messages, not tokens. A shrunk request still costs one message, so ChatGPT's cards can only show 0
today.

## Langfuse (optional)

[Langfuse](https://langfuse.com/) is a free, open-source observability tool. With its keys set, each gate sends
its new ledger rows there as it runs, for session-by-session analysis.

1. Create a project at [cloud.langfuse.com](https://cloud.langfuse.com) (or
   [us.cloud.langfuse.com](https://us.cloud.langfuse.com)) and make API keys under **Project Settings**.
2. Put the three values in `~/.slm-gate/.env` and run `slm-gate restart`:

   ```ini
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   LANGFUSE_HOST=https://us.cloud.langfuse.com
   ```

3. `slm-gate setup-dashboard` builds the dashboard and its widgets in your Langfuse project.
4. `slm-gate ledger:sync --all` sends your history; `--dry-run` previews it. Running it again is safe: every
   trace has the same id each time and is updated in place.
5. In Langfuse, set the dashboard's **Env** selector to every environment `slm-gate doctor` names.

Langfuse keeps only the last `LANGFUSE_RETENTION_DAYS` days, so a total there can fall over time. The permanent
record is the local ledger. Widgets, scores, environments and the daily publishing job:
[Analytics](../reference/analytics.md).

## Troubleshooting

- **The table is empty:** no task has gone through yet, or `LEDGER_PATH` points at another file.
- **Tokens saved is 0:** nothing large enough to shrink has gone through (`DISTILL_MIN_TOKENS`), or your coding
  tool is not sending its AI requests through the gate. `slm-gate doctor` prints the line to paste into each tool.
- **A skill lost a sentence:** the fidelity card names it, and the guard protects that sentence by code on every
  later run.

---

Next: [Set up with an AI assistant](ai-assisted-setup.md)
