/**
 * @fileoverview CLI utility script to synchronize/backfill SQLite ledger records to Langfuse Cloud.
 * 
 * Every id it sends is deterministic (trace = request_id, scores and generations derived
 * from it), so a re-send updates in place and never duplicates. That makes it the backfill:
 * re-running it gives old traces the current tags. Each event keeps the environment it was
 * written under: Langfuse moves a re-sent trace to a new environment but never its scores
 * (tested 2026-09-23), so moving history would split every trace from its own scores.
 *
 * Usage:
 *   pnpm run ledger:sync [--all] [--limit <n>] [--after <rowid>] [--dry-run]
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { CONFIG, requireKeys } from '../config.js';
import { waitWithBackoff } from '../utils/backoff.js';
import { formatDuration } from '../utils/duration.js';
import { computeCycleRateAvg, computeCycleRates, formatEventForLangfuse, getDb, LangfuseSink, LedgerEvent, logLedgerInfo } from './index.js';
import { initLangfuseConfigs } from './sync-config.js';

export { computeCycleRateAvg };

/** Hobby projects allow 30 requests a minute; one batch every 2.1 s stays under it. */
const REQUEST_SPACING_MS = 2100;
const MAX_ATTEMPTS = 5;

interface SyncStats {
  totalEvents: number;
  syncedTraces: number;
  localCalls: number;
  cloudCalls: number;
  localTokens: number;
  cloudTokens: number;
  baselineCostUsd: number;
  actualCostUsd: number;
  costSavedUsd: number;
  tokensSaved: number;
  baselineTokens: number;
  errors: number;
  /** Set when a batch was refused after every retry: the rowid to pass as --after to continue. */
  resumeAfter?: number;
}

export async function syncLedgerToLangfuse(options: { limit?: number; after?: number; dryRun?: boolean } = {}): Promise<SyncStats> {
  const { limit, after = 0, dryRun = false } = options;

  console.log('=== SLM Gate: SQLite to Langfuse Ledger Sync ===\n');
  console.log(`Database Source : ${path.resolve(CONFIG.LEDGER_PATH)}`);
  console.log(`Target Host     : ${CONFIG.LANGFUSE_HOST || '<Not Set>'}`);
  console.log(`Mode            : ${dryRun ? 'DRY-RUN (No network requests)' : 'LIVE SYNC'}\n`);
  logLedgerInfo('sync');

  if (!dryRun) {
    requireKeys(['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST']);
    await initLangfuseConfigs();
  }

  const db = getDb();
  let query = 'SELECT rowid AS ledger_rowid, * FROM events WHERE rowid > ? ORDER BY rowid ASC';
  if (limit && limit > 0) {
    query += ` LIMIT ${limit}`;
  }

  const rows = db.prepare(query).all(after) as Array<LedgerEvent & { ledger_rowid: number }>;
  console.log(`Found ${rows.length} total event(s) in SQLite ledger.\n`);

  if (rows.length === 0) {
    console.log('No events to synchronize.');
    return {
      totalEvents: 0,
      syncedTraces: 0,
      localCalls: 0,
      cloudCalls: 0,
      localTokens: 0,
      cloudTokens: 0,
      baselineCostUsd: 0,
      actualCostUsd: 0,
      costSavedUsd: 0,
      tokensSaved: 0,
      baselineTokens: 0,
      errors: 0,
    };
  }

  const stats: SyncStats = {
    totalEvents: rows.length,
    syncedTraces: 0,
    localCalls: 0,
    cloudCalls: 0,
    localTokens: 0,
    cloudTokens: 0,
    baselineCostUsd: 0,
    actualCostUsd: 0,
    costSavedUsd: 0,
    tokensSaved: 0,
    baselineTokens: 0,
    errors: 0,
  };

  const BATCH_SIZE = 50;
  let batchCount = 0;
  // Rowid of the last event whose batch Langfuse accepted: where a stopped run resumes.
  let lastAcceptedRowid = after;
  let batchLastRowid = after;

  let batch: unknown[] = [];
  /**
   * Sends the pending batch, paced under the rate limit and retried on 429, 5xx and network
   * errors. Returns false when Langfuse still refuses it, so the caller stops instead of
   * skipping a batch: a skipped batch would leave a gap nobody sees.
   */
  const flushBatch = async (): Promise<boolean> => {
    if (batch.length === 0) return true;
    const auth = Buffer.from(`${CONFIG.LANGFUSE_PUBLIC_KEY}:${CONFIG.LANGFUSE_SECRET_KEY}`).toString('base64');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await setTimeout(REQUEST_SPACING_MS);
      let res: Response;
      try {
        res = await fetch(`${CONFIG.LANGFUSE_HOST}/api/public/ingestion`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ batch })
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === MAX_ATTEMPTS - 1) {
          console.error('\nNetwork error during sync:', message);
          break;
        }
        await waitWithBackoff(attempt, MAX_ATTEMPTS, `Langfuse network error (${message})`, null, 'sync');
        continue;
      }

      let body: { errors?: Array<{ id?: string; status?: number; message?: string; error?: string }> } | null = null;
      try {
        body = await res.json() as { errors?: Array<{ id?: string; status?: number; message?: string; error?: string }> };
      } catch { /* not JSON */ }

      if (res.ok) {
        // A 207 accepts the batch but may reject single items; they are counted, and
        // ledger:verify shows which score names came up short.
        if (body && Array.isArray(body.errors) && body.errors.length > 0) {
          for (const e of body.errors) {
            console.error(`[sync] Langfuse per-item error: id=${e.id ?? 'unknown'} status=${e.status ?? 'unknown'} ${e.message ?? e.error ?? ''}`);
          }
          stats.errors += body.errors.length;
        }
        stats.syncedTraces += batchCount;
        lastAcceptedRowid = batchLastRowid;
        process.stdout.write(`\rProgress: ${stats.syncedTraces}/${rows.length} traces synced...`);
        batch = [];
        batchCount = 0;
        return true;
      }

      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === MAX_ATTEMPTS - 1) {
        console.warn(`\nLangfuse sync failed (${res.status}): ${body ? JSON.stringify(body) : '(no body)'}`);
        break;
      }
      await waitWithBackoff(attempt, MAX_ATTEMPTS, `Langfuse ingestion ${res.status}`, res.headers.get('retry-after'), 'sync');
    }
    stats.errors += batchCount;
    return false;
  };

  const hasClient = !dryRun && LangfuseSink.hasValidConfig();
  if (!dryRun && !hasClient) {
    throw new Error('Could not initialize Langfuse sync. Verify LANGFUSE_* keys in .env.');
  }

  for (let i = 0; i < rows.length; i++) {
    const event = rows[i];
    try {
      const payload = formatEventForLangfuse(event);
      const meta = payload.trace.metadata || {};

      stats.actualCostUsd += event.cost_usd || 0;
      stats.baselineCostUsd += Number(meta.baseline_cost_usd || event.cost_usd || 0);
      stats.costSavedUsd += Number(meta.cost_saved_usd || 0);
      stats.tokensSaved += Number(meta.tokens_saved || 0);
      stats.baselineTokens += Number(meta.baseline_tokens || 0);

      if (event.is_local_call) {
        stats.localCalls++;
        stats.localTokens += (event.in_tok || 0) + (event.out_tok || 0);
      }
      if (event.api_model && (event.api_in_tok > 0 || event.api_out_tok > 0)) {
        stats.cloudCalls++;
        stats.cloudTokens += (event.api_in_tok || 0) + (event.api_out_tok || 0);
      }

      if (hasClient) {
        // Langfuse stamps the ingestion envelope, not the body, and ScoreBody has no
        // timestamp field. Using new Date() here backdated nothing: it collapsed the entire
        // backfill onto the moment the sync ran, destroying the time series.
        const envelopeTs = payload.eventTs ?? payload.trace?.timestamp ?? new Date(event.ts).toISOString();

        batch.push({
          id: crypto.randomUUID(),
          type: 'trace-create',
          timestamp: envelopeTs,
          body: payload.trace
        });
        
        const generations = payload.generations || (payload.generation ? [payload.generation] : []);
        for (const gen of generations) {
          batch.push({
            id: crypto.randomUUID(),
            type: 'generation-create',
            timestamp: envelopeTs,
            body: {
              ...gen,
              traceId: payload.trace.id
            }
          });
        }

        if (payload.scores && Array.isArray(payload.scores)) {
          for (const score of payload.scores) {
            batch.push({
              id: crypto.randomUUID(),
              type: 'score-create',
              timestamp: envelopeTs,
              body: {
                ...score,
                traceId: payload.trace.id
              }
            });
          }
        }
        
        if (payload.span) {
          batch.push({
            id: crypto.randomUUID(),
            type: 'span-create',
            timestamp: envelopeTs,
            body: {
              ...payload.span,
              traceId: payload.trace.id
            }
          });
        }

        batchCount++;
        batchLastRowid = event.ledger_rowid;
        if (batchCount >= BATCH_SIZE && !(await flushBatch())) {
          stats.resumeAfter = lastAcceptedRowid;
          break;
        }
      } else {
        stats.syncedTraces++;
      }
    } catch (err: any) {
      stats.errors++;
      console.error(`\nError syncing event ${event.request_id}:`, err.message || err);
    }
  }

  if (hasClient && stats.resumeAfter === undefined && !(await flushBatch())) {
    stats.resumeAfter = lastAcceptedRowid;
  }
  if (stats.resumeAfter !== undefined) {
    console.error(`\nStopped: Langfuse refused a batch after ${MAX_ATTEMPTS} attempts. Everything up to ledger rowid ${stats.resumeAfter} was accepted.`);
    console.error(`Continue with: pnpm run ledger:sync --after ${stats.resumeAfter}`);
  }

  const avgRates = computeCycleRateAvg(rows);
  const totalRates = computeCycleRates(rows);

  /**
   * One summary row per provider, rendered as real durations so the reader never has to
   * convert a decimal fraction of a minute in their head.
   *
   * @param id Provider id as used by computeCycleRateAvg / computeCycleRates
   * @param budgetVar Name of the env var that supplies the denominator
   */
  const cycleRow = (id: 'claude' | 'chatgpt' | 'gemini', budgetVar: string) => {
    const avgMinutes = avgRates[id];
    if (avgMinutes === null) {
      return `n/a (no traffic, or ${budgetVar} unset)`;
    }
    return `~${formatDuration(avgMinutes * 60)} per prompt · ~${formatDuration(totalRates[id] * 60)} total`;
  };

  const claudePlan = CONFIG.RESOLVED_PLAN_CLAUDE;
  const chatgptPlan = CONFIG.RESOLVED_PLAN_CHATGPT;
  const geminiPlan = CONFIG.RESOLVED_PLAN_GEMINI;

  if (!dryRun) {
    process.stdout.write(`\rProgress: ${stats.syncedTraces}/${rows.length} traces synced.\n\n`);
  } else {
    console.log();
  }

  console.log('--- Sync Summary Table ---');
  console.table([
    { Metric: 'Total Events in SQLite', Value: stats.totalEvents },
    { Metric: 'Traces Processed', Value: stats.syncedTraces },
    { Metric: 'Local SLM Calls ($0.00)', Value: stats.localCalls },
    { Metric: 'Local Tokens Processed', Value: stats.localTokens.toLocaleString() },
    { Metric: 'Cloud API Calls', Value: stats.cloudCalls },
    { Metric: 'Cloud Tokens Billed', Value: stats.cloudTokens.toLocaleString() },
    { Metric: 'Baseline Estimated Cost', Value: `$${stats.baselineCostUsd.toFixed(4)}` },
    { Metric: 'Actual Cost Incurred', Value: `$${stats.actualCostUsd.toFixed(4)}` },
    { Metric: 'Net Dollars Saved', Value: `$${stats.costSavedUsd.toFixed(4)}` },
    { Metric: 'Net Tokens Saved', Value: stats.tokensSaved.toLocaleString() },
    { Metric: 'Sync Errors', Value: stats.errors },
    { Metric: `Window Time Saved (ChatGPT ${chatgptPlan.windowMinutes}m window)`, Value: cycleRow('chatgpt', 'CHATGPT_WINDOW_BUDGET') },
    { Metric: `Window Time Saved (Claude ${claudePlan.windowMinutes}m window)`, Value: cycleRow('claude', 'CLAUDE_WINDOW_BUDGET') },
    { Metric: `Window Time Saved (Gemini ${geminiPlan.windowMinutes}m window)`, Value: cycleRow('gemini', 'GEMINI_WINDOW_BUDGET') },
  ]);
  console.log('Window time saved is an estimate within a margin of error: providers do not publish their window limits, so the *_WINDOW_BUDGET values are best guesses.');

  return stats;
}

// Execution entry point
const isDirectCall = process.argv[1] && (
  process.argv[1].endsWith('sync.ts') || 
  process.argv[1].endsWith('sync.js')
);

if (isDirectCall) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  let limit: number | undefined;
  if (limitIdx >= 0 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10);
  }
  const afterIdx = args.indexOf('--after');
  const after = afterIdx >= 0 ? Number(args[afterIdx + 1]) : 0;
  if (!Number.isInteger(after) || after < 0) {
    console.error('--after takes a ledger rowid (a whole number), as printed by a stopped sync.');
    process.exit(1);
  }

  syncLedgerToLangfuse({ limit, after, dryRun })
    .then((stats) => {
      if (stats.resumeAfter !== undefined) process.exit(1);
      console.log('Sync process complete.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Fatal sync error:', err.message || err);
      process.exit(1);
    });
}
