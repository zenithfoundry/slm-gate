# Analytics

The ledger in detail, Langfuse, publishing the dashboard, and reading the numbers. For day-to-day use, see [Measure your savings](../npm/measure-savings.md).

## Two tiers

```text
          Coding tool request or tool result
                        │
              [ the gate's decision ]
   forward_compressed | forward_raw | condition | memory_fold
                        │
                        ▼
      TIER 1: the local ledger (always on, offline, free)
      ~/.slm-gate/output/ledger.sqlite (npm) or output/ledger.sqlite (git)
                        │  optional mirror, every 15 s
                        ▼
      TIER 2: Langfuse (hosted or self-hosted dashboards and scores)
```

- **Tier 1, the ledger:** always active, no account, no internet. Every request from either gate writes one row.
  Where it lives, and why `LEDGER_PATH` must be a full path: [Settings](settings.md#the-ledger-and-langfuse).
- **Tier 2, Langfuse:** optional. With the three `LANGFUSE_*` keys set, each gate sends its new rows there as it
  runs (at start-up, every 15 seconds and at shutdown), with trace tags, cost details, token counts and scores.
  `slm-gate ledger:sync` re-sends history.

## What the rows mean

| Route | Layer | Meaning |
| :--- | :--- | :--- |
| `forward_compressed` | model gate | Sent to the provider with some tool output shrunk |
| `forward_raw` | model gate | Sent unchanged: nothing was large enough to shrink |
| `condition` | MCP gate | A tool result shrunk on its way back to the coding tool |
| `memory_fold` | model gate | The brain model folded a turn into the conversation memory; local tokens only, never the text |
| `feedback` | MCP gate | An expansion the cloud model asked for (`expand_elision`); charged against savings |
| `defer_local` | model gate | Only in ledgers written before 1.4; still counted and priced as they were |

Neither `feedback` nor `memory_fold` counts as a routing decision on the dashboard. Rows carry `slm_gate=on`;
`off` rows come only from a benchmark that versions before 1.4 shipped and are excluded from every savings figure.

Query it with any SQLite client:

```bash
sqlite3 ~/.slm-gate/output/ledger.sqlite
SELECT ts, layer, route, is_local_call, slm_model, api_model, cost_usd FROM events ORDER BY ts DESC LIMIT 10;
SELECT route, count(*) AS count, sum(cost_usd) AS total_spent FROM events GROUP BY route;
```

Other tables in the same file: the saved originals of cut lines (`ELISION_*` settings bound their size), the
model gate's shrink decisions, the conversation memory, the learned protections (`distill_protect`) and the
repository index. Deleting the ledger (`slm-gate ledger:reset --yes`) removes all of them.

## Langfuse

Keys and the first sync: [Measure your savings](../npm/measure-savings.md#langfuse-optional). The rest:

### Model pricing

Langfuse has built-in rates for standard OpenAI and Anthropic models. `slm-gate` also sends exact `costDetails`
with every generation, so costs show even without a custom model definition. To price another model: **Project
Settings > Models > + Add Model Definition**, with a match pattern such as `(?i)^gemini-2.5-flash.*$`, unit
`TOKENS`, and the input and output price per token.

### The dashboard and its scores

`slm-gate setup-dashboard` builds the "SLM Gate ROI & Performance" dashboard. By hand, its widgets are:

| Widget | Type | Reads |
| :--- | :--- | :--- |
| Total net dollars saved | number card | score `cost_saved_usd`, sum |
| Tokens saved by strategy | bar chart | score `tokens_saved`, sum, grouped by tag `route` |
| Request routing split | pie chart | count of traces, grouped by tag `route` |
| Local against cloud latency | percentile latency chart | observation name `local_slm_generation` against `cloud_api_call`, p50/p90/p99 |
| Cycle cards per provider | number cards | scores `cycle_extended_seconds_*` (average) and `cycle_extended_minutes_*` (sum) |

The two cycle scores carry the same value in different units because a Langfuse widget cannot divide by 60.
The categorical score `verified` labels each trace `Distilled (Forwarded)` (shrunk, then sent) or
`Escalated (Cloud)` (sent unchanged); ledgers from before 1.4 also have `Passed (Local SLM)`. Langfuse's home
page rounds score averages to two decimals, so `cost_saved_usd` often shows as `0` there; the exact sum is in the
number card.

Every trace carries the tag `source:slm-gate`, so `ledger:verify` and `ledger:wipe-langfuse` can tell the gate's
traces from another program writing to the same project. The cards filter on score names only the gate writes,
not on the tag.

### Environments

New traffic goes to the Langfuse environment `LANGFUSE_ENVIRONMENT` (`slm-gate`). Events written before
2026-09-23 stay in `default`: Langfuse moves a re-sent trace to a new environment but never its scores, so moving
history would split every trace from its own scores. **Set the dashboard's Env selector to both `default` and
`slm-gate`**; with only one, the cards look empty or short. `slm-gate doctor` prints the exact selection for your
ledger. Leave `bench` out unless you want benchmark runs.

### `ledger:sync`: backfill and repair

```bash
slm-gate ledger:sync --dry-run      # preview, no network
slm-gate ledger:sync --all          # every event
slm-gate ledger:sync --limit 20     # the newest 20
```

- **Idempotent.** Every trace, generation and score has a deterministic id (`request_id`, `${request_id}_gen_*`,
  `${request_id}_score_*`), so a re-send updates in place and never duplicates. Checked 2026-09-23: 891 traces
  and 760 `verified` scores before a full re-send, the same after.
- **Paced and resumable.** One batch of 50 events every 2.1 s, retried on 429 and 5xx. If Langfuse still refuses
  a batch, the run stops and prints `ledger:sync --after <rowid>` to continue from the last accepted event.
- **It is also the backfill.** Run it after any change to what the gate sends (tags, score names), and old
  traces pick up the change. Only ledger-backed events can be restored; traces from other programs, or from
  test runs with a throwaway ledger, are not in the ledger and never show on the cards.
- It prints the cycle figures as readable durations, such as `~11.4s per prompt · ~4m 12s total`.

### Retention: why a total can go down

Langfuse keeps only the last `LANGFUSE_RETENTION_DAYS` days (Hobby: 30). Older days drop off as new ones arrive,
so a summed card can fall even during heavy use. The permanent record is the local ledger; from a checkout,
`pnpm run ledger:report` prints tokens saved per UTC day and all-time, and a day there equals the Tokens Saved
card with Langfuse's date picker set to that UTC day.

### `ledger:verify`

From a checkout: `pnpm run ledger:verify --from 2026-09-20 --to 2026-09-23` (both days included, UTC). Read-only:
it opens the ledger read-only and sends only GET requests. For the window it prints ledger events, Langfuse
traces (all writers, those tagged `source:slm-gate`, and the gate's own counted by their `verified` score), and
per score name the count the ledger produces against the count Langfuse holds. Run it before and after any
repair. Rows marked "retired name, safe to ignore" are scores an earlier build wrote under a name no longer used;
`setup-dashboard` removes any widget that still reads them.

## Publishing the dashboard

The built-in dashboard runs from a git checkout ([Set up from source](../source/setup.md#the-dashboard)). It
reads the ledger directly, so it reconstructs provider cycles, which Langfuse cannot, and it keeps working after
Langfuse Cloud retires its v1 read APIs on 2026-11-16.

```bash
pnpm run dashboard            # live at http://localhost:8790, read-only, local-only
pnpm run dashboard:export     # writes site/index.html and site/data.json for static hosting
```

**Free hosting on GitHub Pages.** `site/data.json` holds aggregates only: counts, token sums, minutes, dates. No
prompts, tool names or skill names leave your machine (the timestamps do show when you work).

1. Once: repository **Settings → Pages → Source: GitHub Actions**.
2. `pnpm run dashboard:export`, commit `site/`, push to `main`. The `.github/workflows/pages.yml` workflow
   deploys it to `https://<owner>.github.io/<repo>/`.
3. The published page never refreshes itself. Re-run the export and push, or schedule it (below).

No GitHub needed, either: open anyone's hosted copy of the page and drag your own `data.json` onto it (it
renders in the browser and uploads nothing), or pass `?data=<url>` pointing at a raw gist of your export.

**Coding tools on the npm install?** The gate then writes to `~/.slm-gate/output/ledger.sqlite`, not the
checkout's ledger, and the page would stop on the day you switched. Put `LEDGER_PATH` in front of each command,
and in the launchd agent below. Set it there, not in the checkout's `.env`: anything you run from the checkout,
benchmarks and tests included, would otherwise write into your real history.

```bash
LEDGER_PATH=$HOME/.slm-gate/output/ledger.sqlite pnpm run dashboard:export
```

The export checks this: when the running gate writes to another ledger, it stops with `dashboard:export failed:
The model gate on port 8787 writes your requests to …` and names the `LEDGER_PATH` to set. `pnpm run dashboard`
prints the same message and still opens. A gate from an older build does not name its ledger; upgrading and
`slm-gate restart` turns the check on.

**By hand, any time:** `pnpm run dashboard:export`, then commit `site/data.json` and push.
`scripts/dashboard-publish.sh` does the same without touching your working copy; `--dry-run` shows the commit it
would push and stops.

### Automatic daily refresh (macOS, free)

A runner on GitHub cannot read the ledger on your machine, so the schedule runs on your Mac and GitHub only
deploys. launchd is built into macOS; for a public repository, GitHub Actions minutes and Pages are free.

It runs once a day at 21:00 local time. If the Mac is asleep then, the job runs once on wake; several missed days
still give one run. When the Mac is off, nothing runs and the page keeps its last numbers. A day adds at most one
commit to `main`, and only when the numbers changed.

What `scripts/dashboard-publish.sh` guards against (the same list is at the top of the script):

| Guard | What it prevents |
| :--- | :--- |
| Builds its commit with git plumbing in a throwaway index on top of the freshly fetched `origin/main`: no checkout, pull, merge, stash or staging | Changing your branch, staged files or uncommitted work. The only local effect is the fetch. |
| Verifies the commit changes exactly `site/data.json` | Publishing anything else; `site/index.html` is never republished by timer. |
| Plain push, never forced | Overwriting work on GitHub. If `main` moved, the push is rejected and the next run retries. |
| Skips when the numbers are unchanged (the `generatedAt` stamp is ignored) | A pointless commit on every idle day. |
| Stops if the export fails, is not valid JSON, or `main` has no published page yet | Publishing a broken or half-set-up dashboard. |
| Temp files owner-only (`umask 077`), deleted on exit | Leaving copies of the export behind. |
| Exports aggregates only; reads and writes no secrets | Leaking prompts, tool names, skill names or keys. |

After a publish your local `main` is one commit behind GitHub; `git pull` as usual.

**Setup.**

1. **Let the job read the repo.** macOS blocks background jobs from `~/Desktop`, `~/Documents` and
   `~/Downloads`; the log then shows `Operation not permitted`. Move the repo outside those folders (for example
   `~/repos`), or grant Full Disk Access to `/bin/bash` (System Settings → Privacy & Security → Full Disk Access).
   Moving the repo is the safer choice.
2. **Create the agent** at `~/Library/LaunchAgents/com.zenithfoundry.slm-gate-dashboard.plist`. Replace `<REPO>`
   with the repo's absolute path, `<NODE_BIN>` with the output of `dirname "$(command -v pnpm)"`, and `<HOME>`
   with your home directory:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.zenithfoundry.slm-gate-dashboard</string>
     <key>ProgramArguments</key>
     <array>
       <string>/bin/bash</string>
       <string><REPO>/scripts/dashboard-publish.sh</string>
     </array>
     <key>EnvironmentVariables</key>
     <dict>
       <key>PATH</key><string><NODE_BIN>:/usr/bin:/bin:/usr/sbin:/sbin</string>
     </dict>
     <key>StartCalendarInterval</key>
     <dict>
       <key>Hour</key><integer>21</integer>
       <key>Minute</key><integer>0</integer>
     </dict>
     <key>StandardOutPath</key><string><HOME>/Library/Logs/slm-gate-dashboard-publish.log</string>
     <key>StandardErrorPath</key><string><HOME>/Library/Logs/slm-gate-dashboard-publish.log</string>
   </dict>
   </plist>
   ```

   launchd starts jobs with a bare `PATH`, so it must name the Node install the repo's dependencies were built
   with (`better-sqlite3` is compiled for that exact Node). After switching Node versions, update `<NODE_BIN>`.
   To change the time, edit `Hour` and `Minute`; for twice a day, turn `StartCalendarInterval` into an `<array>`
   of two such `<dict>`s.

   **If your coding tools run the npm install**, also add this line under the `PATH` line:

   ```xml
       <key>LEDGER_PATH</key><string><HOME>/.slm-gate/output/ledger.sqlite</string>
   ```
3. **Check it:** `plutil -lint ~/Library/LaunchAgents/com.zenithfoundry.slm-gate-dashboard.plist`, then
   `scripts/dashboard-publish.sh --dry-run` from the repo.
4. **Load it, then run it once now**, as yourself, without `sudo` (the agent belongs to your login session):

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.zenithfoundry.slm-gate-dashboard.plist
   launchctl kickstart gui/$(id -u)/com.zenithfoundry.slm-gate-dashboard
   tail ~/Library/Logs/slm-gate-dashboard-publish.log
   ```

   The kickstart run is real: it publishes if the numbers changed.
5. **Pushing unattended** needs an SSH key without a passphrase prompt. If your key has one, store it in the
   keychain (`ssh-add --apple-use-keychain ~/.ssh/<key>`, plus `UseKeychain yes` under `Host github.com` in
   `~/.ssh/config`).

**Stop it:** `launchctl bootout gui/$(id -u)/com.zenithfoundry.slm-gate-dashboard`, then delete the plist. After
editing the plist, `bootout` and `bootstrap` again.

**Linux:** a cron line does the same (cron skips runs missed while the machine was off):

```bash
0 21 * * * PATH=<NODE_BIN>:/usr/bin:/bin <REPO>/scripts/dashboard-publish.sh >> $HOME/slm-gate-dashboard-publish.log 2>&1
```

| Symptom | Cause and fix |
| :--- | :--- |
| `Bootstrap failed: 5: Input/output error` | The plist is missing at that path, invalid (`plutil -lint` it), or already loaded (`bootout` first). |
| `sudo: bootstrap: command not found` | The command is `launchctl bootstrap`, and it must run without `sudo`. |
| `Could not find service … in domain for user gui` | `bootstrap` failed, so there is nothing to `kickstart`. |
| `Operation not permitted` in the log | macOS folder protection; see setup step 1. |
| `pnpm not found on PATH` in the log | `<NODE_BIN>` in the plist is wrong or outdated. |
| `push rejected` in the log | `main` moved on GitHub; the next run retries, or run the script by hand. |
| `dashboard:export failed: The model gate … writes your requests to …` | Your coding tools run another install (usually npm). Add the `LEDGER_PATH` line from setup step 2, then `bootout` and `bootstrap` again. |
| The page shows far fewer requests than you made, or stops on one day | Same cause, with a gate too old to name its ledger. `slm-gate doctor` from the npm install names its ledger. |
| `git pull` conflicts on `site/data.json` | You also committed a hand-made export. Keep either version; the next export replaces it. |
| Changed the dashboard page itself | The timer never publishes `site/index.html`. Run `pnpm run dashboard:export`, commit `site/`, push. |

## Reading the numbers

What the cycle cards mean and where the budgets come from: [Measure your savings](../npm/measure-savings.md#what-the-cycle-cards-mean)
and [Settings: savings figures](settings.md#savings-figures).

| What the data shows | What to do |
| :--- | :--- |
| Most rows are `forward_compressed` and the fidelity card shows nothing lost | The gate is doing its job. Check the fidelity card now and then. |
| The fidelity card shows `recall_fail` or `not_shrunk` often | The gate model drops requirement sentences from skills. Try a bigger gate model for your RAM, or set `DISTILL_SKILLS=off` so skills go out word for word. |
| High latency on `local_slm_generation` (p90 over 5 seconds) | Your GPU or RAM is saturated. Lower `NUM_CTX` or the models ([Hardware](hardware.md#memory-maths)), and check Ollama uses the GPU (`ollama ps`). |
| Most rows are `forward_raw` | Requests carry nothing large enough to shrink. Normal for short conversations. |

## Questions

- **Does the gate stop if Langfuse is down or the keys are missing?** No. Langfuse is fully optional; the gate
  keeps writing to the ledger alone.
- **How do I start the ledger fresh?** `slm-gate ledger:reset --yes`. It deletes the file `LEDGER_PATH` names,
  with every saving recorded, and there is no undo. The next request starts a new ledger.
- **Why does an old Langfuse dashboard show $0.00 for model costs?** Earlier builds passed `cost_usd` as
  metadata rather than Langfuse's `costDetails`. `slm-gate ledger:sync --all` re-sends every event with full cost
  details.

---

Next: [All docs](../README.md)
