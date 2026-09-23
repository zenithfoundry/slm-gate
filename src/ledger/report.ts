/**
 * @fileoverview Tokens saved per day and all-time, from the local ledger alone.
 *
 * The ledger is the complete record; Langfuse keeps only its rolling retention window, so
 * its cards cover less as days drop off. Reuses the per-event arithmetic the Langfuse scores
 * are built from (perEventTokensSaved / perEventBaselineTokens), so a day here equals the
 * Tokens Saved card for the same UTC day. Opens the ledger read-only.
 *
 * Usage:
 *   pnpm run ledger:report
 */

import Database from 'better-sqlite3';
import { CONFIG } from '../config.js';
import { isEntryPoint } from '../utils/entry-point.js';
import { perEventBaselineTokens, perEventTokensSaved, type LedgerEvent } from './index.js';

export interface SavingsRow {
  /** UTC day, YYYY-MM-DD, or 'all-time'. */
  day: string;
  events: number;
  baselineTokens: number;
  tokensSaved: number;
  /** The part of tokensSaved that came from benchmark runs, not real traffic. */
  benchTokensSaved: number;
}

/** One row per UTC day in date order, then an all-time row that is their sum. */
export function savingsByDay(events: LedgerEvent[]): SavingsRow[] {
  const days = new Map<string, SavingsRow>();
  const total: SavingsRow = { day: 'all-time', events: 0, baselineTokens: 0, tokensSaved: 0, benchTokensSaved: 0 };
  for (const event of events) {
    const day = new Date(event.ts).toISOString().slice(0, 10);
    const row = days.get(day) ?? { day, events: 0, baselineTokens: 0, tokensSaved: 0, benchTokensSaved: 0 };
    const saved = perEventTokensSaved(event);
    const baseline = perEventBaselineTokens(event);
    const bench = event.environment === 'bench' ? saved : 0;
    for (const target of [row, total]) {
      target.events += 1;
      target.baselineTokens += baseline;
      target.tokensSaved += saved;
      target.benchTokensSaved += bench;
    }
    days.set(day, row);
  }
  return [...[...days.values()].sort((a, b) => a.day.localeCompare(b.day)), total];
}

function report(): void {
  const db = new Database(CONFIG.LEDGER_PATH, { readonly: true, fileMustExist: true });
  let events: LedgerEvent[];
  try {
    events = db.prepare('SELECT * FROM events ORDER BY ts').all() as LedgerEvent[];
  } finally {
    db.close();
  }

  console.log('=== SLM Gate: tokens saved (local ledger) ===\n');
  console.log(`Ledger: ${CONFIG.LEDGER_PATH}`);
  console.log(`The ledger is the complete record. Langfuse keeps only the last ${CONFIG.LANGFUSE_RETENTION_DAYS} days ` +
    '(LANGFUSE_RETENTION_DAYS), so its cards cover less as older days drop off.\n');

  const pct = (part: number, whole: number) => whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a';
  console.table(savingsByDay(events).map(r => ({
    'Day (UTC)': r.day,
    Events: r.events,
    'Baseline tokens': r.baselineTokens.toLocaleString('en-US'),
    'Tokens saved': r.tokensSaved.toLocaleString('en-US'),
    'Saved %': pct(r.tokensSaved, r.baselineTokens),
    'of which bench': r.benchTokensSaved.toLocaleString('en-US'),
  })));
  console.log('Days are UTC: set Langfuse\'s date picker to the same UTC day to compare with the Tokens Saved card.');
  console.log('"of which bench" is savings from benchmark runs (Env = bench), already included in "Tokens saved".');
}

if (isEntryPoint(import.meta.url)) {
  try {
    report();
  } catch (err) {
    console.error('ledger:report failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
