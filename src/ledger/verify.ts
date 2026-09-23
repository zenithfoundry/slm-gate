/**
 * @fileoverview Read-only reconciliation of the local ledger against Langfuse.
 *
 * For a window of UTC days, prints how many events the ledger holds, how many traces
 * Langfuse holds (from every writer and from the gate alone), and, per score name, how many
 * scores the ledger's events produce against how many Langfuse holds. Run it before and
 * after any repair. It never writes: the ledger is opened read-only (getDb() is not — it
 * migrates and prunes on open) and only GET requests are sent.
 *
 * Usage:
 *   pnpm run ledger:verify --from 2026-09-20 --to 2026-09-23   (both days included)
 */

import Database from 'better-sqlite3';
import { CONFIG, requireKeys } from '../config.js';
import { isEntryPoint } from '../utils/entry-point.js';
import { waitWithBackoff } from '../utils/backoff.js';
import { formatEventForLangfuse, SLM_GATE_SOURCE_TAG, type LedgerEvent } from './index.js';
import { RETIRED_SCORE_NAMES } from './sync-config.js';

/** Hobby projects allow 30 requests a minute; one every 2.1 s stays under it. */
const REQUEST_SPACING_MS = 2100;
const MAX_RETRIES = 3;

export interface VerifyWindow {
  /** Inclusive, ISO. */
  from: string;
  /** Exclusive, ISO: the start of the day after the last day asked for. */
  to: string;
}

export interface ScoreDelta {
  name: string;
  expected: number;
  actual: number;
  delta: number;
  /** Why a row the ledger does not explain is there, when that is known. */
  note: string;
}

/**
 * Reads `--from YYYY-MM-DD --to YYYY-MM-DD` (both days included, UTC).
 *
 * @throws When either date is missing or malformed, or --to is before --from.
 */
export function parseWindow(args: string[]): VerifyWindow {
  const day = (flag: string) => {
    const value = args[args.indexOf(flag) + 1];
    if (!args.includes(flag) || !/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      throw new Error(`${flag} YYYY-MM-DD is required. Usage: pnpm run ledger:verify --from 2026-09-20 --to 2026-09-23 (both days included, UTC)`);
    }
    return new Date(`${value}T00:00:00Z`);
  };
  const from = day('--from');
  const to = day('--to');
  if (to < from) throw new Error('--to is before --from.');
  to.setUTCDate(to.getUTCDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Score counts, by name, that the ledger's events produce with this build's formatting —
 * what a sync of these events would send today.
 */
export function expectedScoreCounts(events: LedgerEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const score of formatEventForLangfuse(event).scores ?? []) {
      counts.set(score.name, (counts.get(score.name) ?? 0) + 1);
    }
  }
  return counts;
}

/** Every score name found on either side, with actual minus expected. Sorted by name. */
export function scoreDeltas(params: { expected: Map<string, number>; actual: Map<string, number> }): ScoreDelta[] {
  const names = [...new Set([...params.expected.keys(), ...params.actual.keys()])].sort();
  return names.map(name => {
    const expected = params.expected.get(name) ?? 0;
    const actual = params.actual.get(name) ?? 0;
    const note = RETIRED_SCORE_NAMES.includes(name) ? 'retired name, safe to ignore'
      : expected === 0 && actual > 0 ? 'not written by this build'
      : '';
    return { name, expected, actual, delta: actual - expected, note };
  });
}

function readLedgerEvents(window: VerifyWindow): LedgerEvent[] {
  const db = new Database(CONFIG.LEDGER_PATH, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT * FROM events WHERE ts >= ? AND ts < ? ORDER BY ts').all(window.from, window.to) as LedgerEvent[];
  } finally {
    db.close();
  }
}

/** One paced GET against Langfuse, retried on 429 and 5xx. Returns null (and says why) on any other failure. */
async function langfuseGet(pathAndQuery: string): Promise<unknown | null> {
  const baseUrl = CONFIG.LANGFUSE_HOST!.replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${CONFIG.LANGFUSE_PUBLIC_KEY}:${CONFIG.LANGFUSE_SECRET_KEY}`).toString('base64')}`;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await new Promise(resolve => setTimeout(resolve, REQUEST_SPACING_MS));
    const res = await fetch(`${baseUrl}${pathAndQuery}`, { headers: { Authorization: auth } });
    if (res.ok) return res.json();
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt === MAX_RETRIES - 1) {
      console.error(`[verify] GET ${pathAndQuery.split('?')[0]} failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
      return null;
    }
    await waitWithBackoff(attempt, MAX_RETRIES, `Langfuse ${res.status}`, res.headers.get('retry-after'), 'verify');
  }
  return null;
}

/** Score counts by name for one score view, from the v2 metrics API. */
async function langfuseScoreCounts(params: { view: 'scores-numeric' | 'scores-categorical'; window: VerifyWindow }): Promise<Map<string, number> | null> {
  const query = {
    view: params.view,
    dimensions: [{ field: 'name' }],
    metrics: [{ measure: 'count', aggregation: 'count' }],
    filters: [],
    fromTimestamp: params.window.from,
    toTimestamp: params.window.to,
  };
  const body = await langfuseGet(`/api/public/v2/metrics?query=${encodeURIComponent(JSON.stringify(query))}`) as { data?: { name: string; count_count: string }[] } | null;
  if (!body?.data) return null;
  return new Map(body.data.filter(row => row.name).map(row => [row.name, Number(row.count_count)]));
}

/**
 * Trace count in the window, optionally only traces carrying `tag`.
 *
 * The v2 metrics API has no traces view, so this reads the total from the trace list
 * (limit=1). Langfuse retires that endpoint on Cloud on 2026-11-16; from then this
 * returns null and the report says the count is unavailable.
 */
async function langfuseTraceCount(params: { window: VerifyWindow; tag?: string }): Promise<number | null> {
  const query = new URLSearchParams({ limit: '1', fromTimestamp: params.window.from, toTimestamp: params.window.to });
  if (params.tag) query.set('tags', params.tag);
  const body = await langfuseGet(`/api/public/traces?${query}`) as { meta?: { totalItems?: number } } | null;
  return typeof body?.meta?.totalItems === 'number' ? body.meta.totalItems : null;
}

async function verify(window: VerifyWindow): Promise<void> {
  requireKeys(['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST']);

  const events = readLedgerEvents(window);
  const byEnvironment = new Map<string, number>();
  for (const e of events) byEnvironment.set(e.environment ?? '(none)', (byEnvironment.get(e.environment ?? '(none)') ?? 0) + 1);

  console.log('=== SLM Gate: ledger ↔ Langfuse reconciliation (read-only) ===\n');
  console.log(`Window  : ${window.from} → ${window.to} (end excluded)`);
  console.log(`Ledger  : ${CONFIG.LEDGER_PATH}`);
  console.log(`Langfuse: ${CONFIG.LANGFUSE_HOST}\n`);
  console.log('Querying Langfuse (paced for the 30 requests/minute limit)...\n');

  const allTraces = await langfuseTraceCount({ window });
  const gateTaggedTraces = await langfuseTraceCount({ window, tag: SLM_GATE_SOURCE_TAG });
  const numeric = await langfuseScoreCounts({ view: 'scores-numeric', window });
  const categorical = await langfuseScoreCounts({ view: 'scores-categorical', window });

  const show = (n: number | null) => n === null ? 'unavailable' : String(n);
  const diff = (n: number | null) => n === null ? '' : `${n - events.length >= 0 ? '+' : ''}${n - events.length}`;
  // Every gate event writes exactly one 'verified' score and no other writer does, so this
  // counts the gate's traces even when they predate the source tag.
  const gateVerified = categorical ? (categorical.get('verified') ?? 0) : null;

  console.table([
    { Measure: 'Ledger events', Count: String(events.length), 'Δ vs ledger': '' },
    ...[...byEnvironment].map(([env, n]) => ({ Measure: `  environment=${env}`, Count: String(n), 'Δ vs ledger': '' })),
    { Measure: 'Langfuse traces, all writers', Count: show(allTraces), 'Δ vs ledger': diff(allTraces) },
    { Measure: `Langfuse traces tagged ${SLM_GATE_SOURCE_TAG}`, Count: show(gateTaggedTraces), 'Δ vs ledger': diff(gateTaggedTraces) },
    { Measure: "Langfuse gate traces (one 'verified' score each)", Count: show(gateVerified), 'Δ vs ledger': diff(gateVerified) },
    {
      Measure: 'Langfuse traces from other writers',
      Count: allTraces === null || gateVerified === null ? 'unavailable' : String(allTraces - gateVerified),
      'Δ vs ledger': '',
    },
  ]);

  if (!numeric || !categorical) {
    console.error('Score counts are unavailable; see the errors above.');
    process.exitCode = 1;
    return;
  }

  const actual = new Map([...numeric, ...categorical]);
  const rows = scoreDeltas({ expected: expectedScoreCounts(events), actual });
  console.log('\nScores by name. Expected = what this build produces for the ledger events above.');
  console.table(rows.map(r => ({
    'Score name': r.name,
    Expected: r.expected,
    Langfuse: r.actual,
    Δ: r.delta === 0 ? '0' : `${r.delta > 0 ? '+' : ''}${r.delta}`,
    Note: r.note,
  })));
  console.log('Langfuse list endpoints can lag live data by about 10 minutes.');
}

if (isEntryPoint(import.meta.url)) {
  let window: VerifyWindow;
  try {
    window = parseWindow(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  verify(window).catch(err => {
    console.error('ledger:verify failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
