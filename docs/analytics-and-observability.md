# Comprehensive Guide: SLM Gate Analytics, SQLite Ledger & Langfuse Observability

> [!IMPORTANT]
> **Who is this guide for?**
> This guide is designed for **everyone** — from beginners with zero prior data analysis or observability experience to engineering leads optimizing LLM infrastructure. It explains how to measure, visualize, and optimize dollar and token savings achieved by `small-language-model-gate`.

---

## Table of Contents
1. [Executive Summary & How It Works](#1-executive-summary--how-it-works)
2. [Dual-Ledger Architecture](#2-dual-ledger-architecture)
3. [Exhaustive Configuration Reference](#3-exhaustive-configuration-reference)
4. [Using Local SQLite Analytics (No Cloud Required)](#4-using-local-sqlite-analytics-no-cloud-required)
5. [0-to-100% Langfuse Setup Walkthrough](#5-0-to-100-langfuse-setup-walkthrough)
6. [Langfuse UI Configuration Guide (Dashboards & Pricing)](#6-langfuse-ui-configuration-guide-dashboards--pricing)
7. [The `ledger:sync` Backfill Tool](#7-the-ledgersync-backfill-tool)
8. [Data Interpretation & Product Decision Framework](#8-data-interpretation--product-decision-framework)
9. [Troubleshooting & Frequently Asked Questions](#9-troubleshooting--frequently-asked-questions)

---

## 1. Executive Summary & How It Works

`small-language-model-gate` intercepts prompts before they reach expensive cloud LLMs (like GPT-5, Claude 3.5/4, or Gemini Pro) and runs small local models (via Ollama) to either:
1. **Resolve simple requests locally (`defer_local`)** at **$0.00 cost** and **0 cloud tokens**.
2. **Compress prompts (`forward_compressed`)** to cut input token volume by 30–70% before forwarding to the cloud.
3. **Condition and ground MCP skill texts (`condition`)** so developer agents don't flood the cloud model with bloated markdown instructions.
4. **Escalate complex requests (`forward_raw`)** when safety checks require the full reasoning power of a cloud model.

To make informed decisions about whether this setup is saving you money or protecting your subscription rate limits, the system logs every single transaction into a structured ledger.

---

## 2. Dual-Ledger Architecture

The analytics pipeline operates in two tiers:

```
                      ┌─────────────────────────────────────────┐
                      │          Incoming LLM/MCP Request       │
                      └────────────────────┬────────────────────┘
                                           │
                                  [ SLM Gate Decision ]
                        (defer_local | forward_compressed | raw)
                                           │
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │       TIER 1: Local SQLite Ledger       │
                      │       (Always On, Offline, $0, Fast)    │
                      │          Location: output/ledger.sqlite │
                      └────────────────────┬────────────────────┘
                                           │ (Optional Async Mirror)
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │       TIER 2: Langfuse Cloud / Host     │
                      │  (Visual UI, Custom Dashboards, Scores) │
                      │      https://us.cloud.langfuse.com      │
                      └─────────────────────────────────────────┘
```

- **Tier 1 (Local SQLite):** Always active out-of-the-box. Requires no accounts, no internet, and zero configuration. Stored locally in `output/ledger.sqlite`.
- **Tier 2 (Langfuse Observability):** Optional visual layer. If you provide Langfuse API credentials in `.env`, events are automatically queued and mirrored to Langfuse with enriched trace tags, model cost details, token analytics, and quantitative quality scores.

---

## 3. Exhaustive Configuration Reference

All settings are controlled via environment variables in your `.env` file (or inherited defaults). Below is the complete configuration dictionary for analytics, ledger, and model pricing:

| Environment Variable | Type | Default Value | Description & Purpose |
| :--- | :--- | :--- | :--- |
| `LEDGER_PATH` | `string` | `./output/ledger.sqlite` | Absolute or relative file path to the local SQLite database where all request records and cache entries are persisted. |
| `LANGFUSE_PUBLIC_KEY` | `string` | *(Optional)* `pk-lf-...` | Public API key generated in your Langfuse project settings. |
| `LANGFUSE_SECRET_KEY` | `string` | *(Optional)* `sk-lf-...` | Secret API key generated in your Langfuse project settings. |
| `LANGFUSE_HOST` | `string` | `https://us.cloud.langfuse.com` | Base URL of the Langfuse server (`https://us.cloud.langfuse.com` for US Cloud, `https://cloud.langfuse.com` for EU Cloud, or `http://localhost:3000` for self-hosted). |
| `CLOUD_MODEL` | `string` | `gemini-2.5-flash` | The primary upstream cloud model name used for baseline cost estimation and cloud forwarding. |
| `CLOUD_API_KEY` | `string` | *(Optional)* | Upstream provider API key (OpenAI, Anthropic, or Google AI Studio). |
| `CLOUD_API_STYLE` | `enum` | `openai` | Protocol style used for cloud communication (`openai` or `anthropic`). |
| `SLM_BRAIN_MODEL` | `string` | Resolved by `RAM_PRESET` | The local model tag used for complex reasoning, classification, and local answering (e.g. `qwen3:14b`, `qwen2.5-coder:3b`). |
| `SLM_GATE_MODEL` | `string` | Resolved by `RAM_PRESET` | The small fast local model tag used for prompt distillation and token compression (e.g. `qwen3:1.7b`, `qwen2.5-coder:0.5b`). |
| `SLM_GATE_TESTING_MODEL` | `string` | Resolved by `SLM_GATE_MODEL` | The dedicated local model tag used specifically for the offline evaluation benchmark harness and test suites (`slm-gate bench`). |
| `RAM_PRESET` | `enum` | `custom` | Hardware RAM profile (`ram-4`, `ram-8`, `ram-12`, `ram-16`, `ram-24`, `ram-32`, `custom`) that automatically assigns optimal local models. |
| `HEADLINE_STRICTNESS`| `number` | `4` | Verification strictness level (`0` to `5`). Higher values make the verifier more skeptical, forcing local answers to escalate to the cloud if uncertain. |

### PLAN_REGISTRY and Token Estimation
The `SUBSCRIPTION_PLAN` environment variable automatically configures your token budget using the following authoritative window lengths and token estimates:

| Plan Key | Provider | Window Length | Multiplier/Msgs |
| :--- | :--- | :--- | :--- |
| `claude-pro` | claude | 300 min | 45 msgs |
| `claude-max-5x` | claude | 300 min | 225 msgs |
| `claude-max-20x` | claude | 300 min | 900 msgs |
| `chatgpt-go` | chatgpt | 180 min | 1x (160 msgs) |
| `chatgpt-plus` | chatgpt | 180 min | 1x (160 msgs) |
| `chatgpt-pro-5x` | chatgpt | 180 min | 5x (160 msgs) |
| `chatgpt-pro-20x` | chatgpt | 180 min | 20x (160 msgs) |
| `gemini-plus` | gemini | 300 min | 2x |
| `gemini-pro` | gemini | 300 min | 4x |
| `gemini-ultra` | gemini | 300 min | 20x |

**Sources (verified 2026-09-09):**
- Claude: <https://support.claude.com/en/articles/11049741-what-is-the-max-plan>
- ChatGPT: <https://help.openai.com>
- Gemini: <https://support.google.com/gemini/answer/16275805>

---

## 4. Using Local SQLite Analytics (No Cloud Required)

If you do not want to use a cloud service, you have full access to local analytics directly from your terminal.

### 1. View Performance & Savings Summary
Run the built-in metrics aggregator:
```bash
pnpm run metrics
```
*(Or if installed globally: `slm-gate metrics`)*

**Sample Terminal Output:**
```text
--- Local SQLite Ledger Metrics ---
┌─────────┬──────────────────────────┬────────────┬────────┬─────────────┬───────┐
│ (index) │ Arm                      │ Cost (USD) │ Tokens │ Avg Quality │ Count │
├─────────┼──────────────────────────┼────────────┼────────┼─────────────┼───────┤
│ 0       │ slm_gate=off (Baseline)  │ $0.1520    │ 45,200 │ 0.94        │ 50    │
│ 1       │ slm_gate=on (Router)     │ $0.0210    │ 8,400  │ 0.96        │ 50    │
└─────────┴──────────────────────────┴────────────┴────────┴─────────────┴───────┘

--- Deltas (on - off) ---
Cost Saved: $0.1310
Tokens Saved: 36,800 (81.4% reduction)
Quality Change: +0.02
```

### 2. Run Synthetic Benchmark Evaluations
To test how well the local router performs against an offline test suite without manual typing:
```bash
pnpm run bench --n 10
```
This generates:
- `output/leaderboard.md`: Per-task accuracy and routing report.
- `output/deferral_curve.svg`: An SVG curve illustrating your system's quality vs. cost Pareto frontier.

### 3. Direct SQL Inspection
You can query the SQLite database with any SQLite client (such as the VS Code SQLite Viewer extension or the `sqlite3` CLI):
```bash
# Open SQLite database
sqlite3 output/ledger.sqlite

# Top 10 most recent routing events
SELECT ts, layer, route, is_local_call, slm_model, api_model, cost_usd FROM events ORDER BY ts DESC LIMIT 10;

# Breakdown of total requests by route
SELECT route, count(*) as count, sum(cost_usd) as total_spent FROM events GROUP BY route;
```

---

## 5. 0-to-100% Langfuse Setup Walkthrough

Follow these sequential steps if you want a live web dashboard in Langfuse.

### Step 1: Create a Langfuse Account
1. Open your browser and navigate to [https://cloud.langfuse.com](https://cloud.langfuse.com) (or [https://us.cloud.langfuse.com](https://us.cloud.langfuse.com) for US data residency).
2. Sign in with GitHub or Google.
3. Click **+ New Project** and enter a name (e.g. `small-language-model-gate`).

### Step 2: Retrieve API Keys
1. In your new project, navigate to **Project Settings** (gear icon in the bottom-left sidebar).
2. Under the **API Keys** section, click **+ Create new API keys**.
3. You will see three values:
   - **Secret Key:** `sk-lf-...`
   - **Public Key:** `pk-lf-...`
   - **Host:** `https://us.cloud.langfuse.com` (or `https://cloud.langfuse.com`)

### Step 3: Configure `.env`
Open `.env` in the repository root and add the keys:
```ini
LANGFUSE_PUBLIC_KEY=pk-lf-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LANGFUSE_SECRET_KEY=sk-lf-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LANGFUSE_HOST=https://us.cloud.langfuse.com
```

### Step 4: Verify the Connection
Run the configuration validation check:
```bash
pnpm run config
```
You should see `sinks: [sqlite, langfuse]` printed in the summary output.

---

## 6. Langfuse UI Configuration Guide (Dashboards & Pricing)

To turn raw telemetry into actionable decision-making charts, configure your Langfuse project with the following steps.

### A. Configuring Custom Model Pricing in Langfuse
By default, Langfuse maintains built-in rates for standard OpenAI and Anthropic models. To ensure models like `gemini-2.5-flash` or custom models are accurately calculated by Langfuse's internal engine:
1. In Langfuse, click **Project Settings** > **Models** in the left sidebar.
2. Click **+ Add Model Definition**:
   - **Model Name:** `gemini-2.5-flash`
   - **Match Pattern (Regex):** `(?i)^gemini-2.5-flash.*$`
   - **Unit:** `TOKENS`
   - **Input Price ($/token):** `0.00000030` *(representing $0.30 per 1M tokens)*
   - **Output Price ($/token):** `0.00000250` *(representing $2.50 per 1M tokens)*
3. Click **Save Model**.
*(Note: Because SLM Gate also directly ingests exact `costDetails` on every generation, Langfuse will record non-zero costs even if custom model pricing is not configured in the UI!)*

---

### B. Building the "SLM Gate ROI & Performance" Dashboard
1. In the left navigation menu, click **Dashboards**.
2. Click **+ New Dashboard** in the top right and name it: `SLM Gate ROI & Performance`.
3. Add the following 5 widgets using the **+ Add Widget** button:

#### Widget 1: Cumulative Dollars Saved ($)
- **Widget Type:** `Number Card` / `Metric`
- **Title:** `Total Net Dollars Saved`
- **Metric Source:** `Scores` -> `cost_saved_usd`
- **Aggregation:** `Sum`
- **Description:** Direct dollar savings compared to sending 100% of raw prompts to cloud models.

#### Widget 2: Tokens Saved by Route
- **Widget Type:** `Bar Chart`
- **Title:** `Tokens Saved by Strategy`
- **X-Axis / Group By:** `Tag: route`
- **Y-Axis / Metric:** `Scores` -> `tokens_saved` -> `Sum`
- **Description:** Shows how many tokens were saved by local deferral vs. compression.

#### Widget 3: Routing Distribution (%)
- **Widget Type:** `Pie Chart` / `Donut`
- **Title:** `Request Routing Split`
- **Group By:** `Tag: route`
- **Metric:** `Count of Traces`
- **Description:** Visualizes the percentage of traffic that resolved locally (`defer_local`) vs. compressed (`forward_compressed`) vs. raw (`forward_raw`).

#### Widget 4: Verification & Quality Pass Rate
- **Widget Type:** `Line Chart (Over Time)`
- **Title:** `Verification & Quality Rate`
- **Metric 1:** `Scores` -> `verified` -> `Avg` (1.0 = 100% pass)
- **Metric 2:** `Scores` -> `quality_score` -> `Avg`
- **Description:** Proves that token savings did not come at the expense of output quality.

#### Widget 5: Model Latency Breakdown
- **Widget Type:** `Percentile Latency Chart`
- **Title:** `Local SLM vs Cloud Latency`
- **Group By:** Observation name (`local_slm_generation` vs `cloud_api_call`)
- **Percentiles:** `p50`, `p90`, `p99`
- **Description:** Compares millisecond response times between local Ollama execution and cloud roundtrips.

### C. Understanding the Built-in Langfuse Scores Overview Table
On the Langfuse Home page, you will see a default **Scores** summary table with columns like:
`Name | # | Avg | 0 | 1`

Here is what each column means:
- **`Name`:** The score identifier (`# tokens_saved`, `# cost_saved_usd`, `# verified`).
- **`#`:** The total number of requests/traces that were scored.
- **`Avg`:** The arithmetic mean of all score values for that metric.
  - *Why does `cost_saved_usd` show `0` or `0.00` in this table?* Modern models (like Gemini Flash) cost fractions of a cent (e.g. `$0.000028` per call). Because Langfuse's default table rounds averages to 2 decimal places, `$0.00009` is displayed as `0`. The exact cumulative dollar amount is preserved in JSON and is visible when summing `cost_saved_usd` in a custom Number Card widget.
- **Columns `0` and `1` (Category / Bucket Counts):**
  - For binary/boolean metrics like `verified`, Langfuse counts how many requests received a score of `0` (Failed / Escalated to Cloud) vs. `1` (Passed Verification locally).
  - For example, if `# verified` has `0: 40` and `1: 78`, it means 78 requests passed verification locally (66.1% pass rate) and 40 escalated.

> [!TIP]
> **Customizing Score Labels in Langfuse:**
> If you want Langfuse to display descriptive labels instead of `0` and `1`:
> 1. Go to **Project Settings > Scores** > **+ Add Score Config**.
> 2. Name: `verified`, Data Type: `Categorical`.
> 3. Add Category `1` with Label `Passed` and Category `0` with Label `Escalated`.
> 4. Langfuse will now render the columns as `Escalated` and `Passed`!

---

## 7. The `ledger:sync` Backfill Tool

If you ran tasks locally before setting up Langfuse, or if you want to push all historical records from SQLite into Langfuse, use the sync tool:

```bash
# Preview what would be synced without sending network requests
pnpm run ledger:sync --dry-run

# Synchronize all historical SQLite records to Langfuse Cloud
pnpm run ledger:sync --all

# Synchronize the latest 20 events only
pnpm run ledger:sync --limit 20
```

### Idempotency & Safety Guarantee
> [!IMPORTANT]
> **Will running `sync` multiple times corrupt or accumulate duplicate metrics?**
> **No.** `ledger:sync` assigns deterministic unique IDs to every trace (`request_id`), generation (`${request_id}_gen_*`), and score (`${request_id}_score_*`).
> 
> When you run `pnpm run ledger:sync` again, Langfuse performs an **in-place idempotent update (UPSERT)**:
> - Existing traces are updated rather than duplicated.
> - Trace counts, token counts, and score counts remain perfectly accurate.
> - You can safely re-run `ledger:sync` at any time.

### What `ledger:sync` does:
1. Reads records sequentially from `output/ledger.sqlite`.
2. Computes baseline costs, tokens saved, and verification status for every event.
3. Formats trace payloads with descriptive names (e.g. `[llm] defer_local`, `[mcp] condition_prompt`).
4. Ingests local SLM calls at `$0.00` and cloud API calls with exact usage and cost details.
5. Pushes quantitative scores (`cost_saved_usd`, `tokens_saved`, `verified`) with deterministic IDs to populate your dashboards.


---

## 8. Data Interpretation & Product Decision Framework (langfuse and bench test results)

### Cycle window model
The dashboard provides **two** cycle cards per provider (Claude, ChatGPT, Gemini), stacked in the same column:

- **Est. Seconds Saved (per prompt)** — the average event, in seconds. Seconds rather than minutes because a typical prompt frees a fraction of a minute, and `0.18934` is not a number anyone can read.
- **Est. Minutes Saved (total)** — the same quantity summed across the dashboard's date range, so it grows with use.

Both are published as separate scores (`cycle_extended_seconds_*` and `cycle_extended_minutes_*`) carrying the same underlying value in different units. That duplication is deliberate: a Langfuse score row carries a number and no unit, and a widget can only choose a measure and an aggregation — it cannot divide by 60. A card that reads in seconds therefore needs a score already in seconds.

A card only fills in when **both** of these are true:
1. There is traffic for that provider.
2. That provider's window budget is set: `CLAUDE_WINDOW_BUDGET`, `CHATGPT_WINDOW_BUDGET` or `GEMINI_WINDOW_BUDGET`. Without a budget the gate has nothing to divide by, so it sends no cycle score at all and the card stays empty. `slm-gate doctor` lists any budgets that are missing.

Each event's value is:

```text
estimated minutes saved = units saved × (window minutes ÷ window budget)    (capped to [0, window minutes])
```

**These minutes are estimates within a margin of error.** Anthropic, OpenAI and Google don't publish their window limits, only multipliers between plans, so every budget is a best guess. The defaults in the `.env` examples, and where each comes from, are listed in the README's settings reference (`*_WINDOW_BUDGET`).

What a "unit" is depends on how the provider counts usage:
- **Per token (Claude / Gemini):** the budget is *tokens per window*. Every token saved counts, including tool results shrunk by `mcp-gate`. Claude is counted this way because its limits scale with how much text is sent, not with a flat message count.
- **Per message (ChatGPT):** the budget is *messages per window*. Only a prompt answered entirely by the local model saves a message, and only `llm-gate` does that. A prompt that was shrunk and then sent (including every `mcp-gate` event) still costs one message, so it adds 0 minutes.

The seconds card averages over events; the minutes card sums them. `pnpm run ledger:sync` prints the same two figures in the terminal as readable durations, e.g. `~11.4s per prompt · ~4m 12s total`.

Use your analytics to make concrete engineering decisions:

```
┌───────────────────────────────────────────────┬─────────────────────────────────────────────────────────────┐
│ What the Data Shows                           │ Recommended Engineering / Product Action                   │
├───────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ High % of `defer_local` (>40%) with           │ Your local SLM is handling tasks well! Consider testing     │
│ 100% `verified` pass rate.                    │ a slightly smaller model preset (e.g. ram-8 -> ram-4) to   │
│                                               │ decrease local RAM and increase inference speed.            │
├───────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ `verified` pass rate drops below 95%, or      │ The local model is attempting tasks that are too hard.      │
│ quality scores decrease on local answers.     │ Increase `HEADLINE_STRICTNESS` in `.env` (e.g. 3 -> 4 or 5) │
│                                               │ to force uncertain tasks to escalate to the cloud.          │
├───────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ High latency on `local_slm_generation`        │ Your local GPU/RAM is saturated. Lower your `RAM_PRESET` or │
│ (p90 > 5 seconds).                            │ ensure Ollama has GPU acceleration enabled (`ollama ps`).   │
├───────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ High % of `forward_raw` (>80%).               │ Prompts are not qualifying for compression or deferral.     │
│                                               │ Check if user prompts contain tool output or complex steps. │
└───────────────────────────────────────────────┴─────────────────────────────────────────────────────────────┘
```

---

## 9. Troubleshooting & Frequently Asked Questions

### Q1: Why did my Langfuse dashboard previously show $0.00 for model costs?
**Answer:** Prior to this update, `cost_usd` was passed inside `metadata: { cost_usd }` rather than Langfuse's dedicated `costDetails` object. Langfuse's dashboard metrics only calculate costs from `costDetails` or matching custom model definitions. Running `pnpm run ledger:sync --all` will re-ingest and backfill all past events with full cost details.

### Q2: Will `small-language-model-gate` crash if Langfuse is offline or keys are missing?
**Answer:** No. The decoupling contract strictly guarantees that Langfuse is 100% optional. If Langfuse keys are unset or network requests fail, the gate continues operating seamlessly, writing records solely to the local SQLite database.

### Q3: How do I clear the local ledger to start fresh?
**Answer:** Stop the running gate process, then delete or move the SQLite database file:
```bash
rm output/ledger.sqlite
```
A fresh, empty database will be initialized automatically upon the next request.
