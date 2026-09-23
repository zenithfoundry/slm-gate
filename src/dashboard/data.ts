/**
 * @fileoverview The dashboard's numbers, computed from the local ledger.
 *
 * One JSON document drives both servings of the dashboard page: `slm-gate dashboard`
 * computes it fresh per request, and `dashboard:export` bakes it into a static site.
 * Everything here is aggregate — counts, token sums, minutes, dates. No prompt text,
 * tool names or skill names leave the machine, so an export is safe to publish.
 *
 * The per-cycle view is the reason this exists locally: a provider window is a rolling
 * span opened by the first request (Claude: 5 h), so cycles can only be reconstructed
 * by clustering events by time — which Langfuse widgets cannot do.
 *
 * Benchmark runs (environment 'bench') are excluded from every savings figure and from
 * routing: they are synthetic. They appear only in the accuracy split, labelled as such.
 */

import Database from 'better-sqlite3';
import { CONFIG } from '../config.js';
import {
  formatEventForLangfuse,
  perEventBaselineTokens,
  perEventCycleMinutes,
  perEventTokensSaved,
  resolveProvider,
  routingOutcome,
  type LedgerEvent,
} from '../ledger/index.js';
import { getProviderRegistry } from '../pricing/providers.js';

export interface CycleRow {
  /** ISO time of the first event in the window: when the provider's clock started. */
  start: string;
  events: number;
  tokensSaved: number;
  /** Minutes of the window returned, or null when the provider's budget is not configured. */
  minutes: number | null;
}

export interface WeekRow {
  /** Monday of the week, UTC, YYYY-MM-DD. */
  weekStart: string;
  events: number;
  tokensSaved: number;
  minutes: number | null;
}

export interface ProviderSection {
  id: string;
  label: string;
  plan: string;
  windowMinutes: number;
  /** Tokens per window from <ID>_WINDOW_BUDGET, or null: minutes are then not measured. */
  windowBudgetTokens: number | null;
  events: number;
  tokensSaved: number;
  minutesTotal: number | null;
  avgMinutesPerCycle: number | null;
  medianMinutesPerCycle: number | null;
  cycles: CycleRow[];
  weeks: WeekRow[];
}

export interface DayRow {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  events: number;
  tokensSaved: number;
  baselineTokens: number;
  resolvedLocal: number;
  distilledForwarded: number;
  escalatedCloud: number;
}

interface AccuracySlice {
  /** Average accuracy score 0–100, or null when nothing was measured. */
  avgPct: number | null;
  n: number;
}

export interface DashboardData {
  generatedAt: string;
  firstEventTs: string | null;
  lastEventTs: string | null;
  realEvents: number;
  benchEvents: number;
  /** Real traffic only, 'feedback' rows excluded: they record a user action, not a routing decision. */
  routing: { resolvedLocal: number; distilledForwarded: number; escalatedCloud: number };
  /** Verifier acceptance, split so hiding benchmark data never blanks the real figure. */
  accuracy: { real: AccuracySlice; bench: AccuracySlice };
  days: DayRow[];
  providers: ProviderSection[];
}

const PROVIDERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'gemini', label: 'Gemini' },
] as const;

function resolvedPlan(id: string): { windowMinutes: number; plan: string } {
  const plans: Record<string, { windowMinutes: number; plan?: string }> = {
    claude: CONFIG.RESOLVED_PLAN_CLAUDE,
    chatgpt: CONFIG.RESOLVED_PLAN_CHATGPT,
    gemini: CONFIG.RESOLVED_PLAN_GEMINI,
  };
  const resolved = plans[id];
  return { windowMinutes: resolved.windowMinutes, plan: resolved.plan ?? id };
}

/** Monday of the event's week, UTC. */
function weekStartOf(ts: string): string {
  const date = new Date(ts);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** The event's accuracy score (0–100) exactly as the Langfuse mirror would emit it, or null. */
function accuracyOf(e: LedgerEvent): number | null {
  const score = formatEventForLangfuse(e).scores?.find(s => s.name === 'accuracy_rate_pct');
  return typeof score?.value === 'number' ? score.value : null;
}

/**
 * Clusters one provider's events into window instances: a cycle opens at its first event
 * and spans windowMinutes; the next event past that boundary opens the next cycle. This
 * mirrors how the providers meter — the window starts on first use, not on the clock hour.
 */
export function clusterCycles(params: { events: LedgerEvent[]; windowMinutes: number; providerId: string }): CycleRow[] {
  const hasBudget = getProviderRegistry()[params.providerId]?.windowBudget != null;
  const cycles: CycleRow[] = [];
  let windowEndMs = -Infinity;
  for (const e of params.events) {
    const t = Date.parse(e.ts);
    if (t >= windowEndMs) {
      windowEndMs = t + params.windowMinutes * 60_000;
      cycles.push({ start: new Date(t).toISOString(), events: 0, tokensSaved: 0, minutes: hasBudget ? 0 : null });
    }
    const cycle = cycles[cycles.length - 1];
    cycle.events += 1;
    cycle.tokensSaved += perEventTokensSaved(e);
    if (cycle.minutes !== null) cycle.minutes += perEventCycleMinutes(e, params.providerId) ?? 0;
  }
  return cycles.map(c => ({ ...c, minutes: c.minutes === null ? null : Number(c.minutes.toFixed(3)) }));
}

/** Pure aggregation over ledger events, so it is testable without a database. */
export function computeDashboardData(events: LedgerEvent[]): DashboardData {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const real = sorted.filter(e => e.environment !== 'bench');
  const bench = sorted.filter(e => e.environment === 'bench');

  const routing = { resolvedLocal: 0, distilledForwarded: 0, escalatedCloud: 0 };
  const days = new Map<string, DayRow>();
  for (const e of real) {
    const day = new Date(e.ts).toISOString().slice(0, 10);
    const row = days.get(day) ?? { day, events: 0, tokensSaved: 0, baselineTokens: 0, resolvedLocal: 0, distilledForwarded: 0, escalatedCloud: 0 };
    row.events += 1;
    row.tokensSaved += perEventTokensSaved(e);
    row.baselineTokens += perEventBaselineTokens(e);
    if (e.route !== 'feedback') {
      const outcome = routingOutcome(e) === 'resolved_local' ? 'resolvedLocal'
        : routingOutcome(e) === 'distilled_forwarded' ? 'distilledForwarded' : 'escalatedCloud';
      row[outcome] += 1;
      routing[outcome] += 1;
    }
    days.set(day, row);
  }

  const accuracySlice = (slice: LedgerEvent[]): AccuracySlice => {
    const scores = slice.map(accuracyOf).filter((v): v is number => v !== null);
    if (scores.length === 0) return { avgPct: null, n: 0 };
    return { avgPct: Number((scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(2)), n: scores.length };
  };

  const registry = getProviderRegistry();
  const providers: ProviderSection[] = PROVIDERS.map(({ id, label }) => {
    const plan = resolvedPlan(id);
    const mine = real.filter(e => resolveProvider(e) === id);
    const cycles = clusterCycles({ events: mine, windowMinutes: plan.windowMinutes, providerId: id });
    const budget = registry[id]?.windowBudget ?? null;

    const weeks = new Map<string, WeekRow>();
    for (const e of mine) {
      const weekStart = weekStartOf(e.ts);
      const row = weeks.get(weekStart) ?? { weekStart, events: 0, tokensSaved: 0, minutes: budget === null ? null : 0 };
      row.events += 1;
      row.tokensSaved += perEventTokensSaved(e);
      if (row.minutes !== null) row.minutes = Number((row.minutes + (perEventCycleMinutes(e, id) ?? 0)).toFixed(3));
      weeks.set(weekStart, row);
    }

    const minuteValues = cycles.map(c => c.minutes).filter((m): m is number => m !== null).sort((a, b) => a - b);
    const round = (n: number) => Number(n.toFixed(3));
    return {
      id,
      label,
      plan: plan.plan,
      windowMinutes: plan.windowMinutes,
      windowBudgetTokens: budget,
      events: mine.length,
      tokensSaved: mine.reduce((s, e) => s + perEventTokensSaved(e), 0),
      minutesTotal: budget === null ? null : round(minuteValues.reduce((s, m) => s + m, 0)),
      avgMinutesPerCycle: minuteValues.length === 0 ? null : round(minuteValues.reduce((s, m) => s + m, 0) / minuteValues.length),
      medianMinutesPerCycle: minuteValues.length === 0 ? null : round(minuteValues[Math.floor(minuteValues.length / 2)]),
      cycles,
      weeks: [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    firstEventTs: sorted[0]?.ts ?? null,
    lastEventTs: sorted[sorted.length - 1]?.ts ?? null,
    realEvents: real.length,
    benchEvents: bench.length,
    routing,
    accuracy: { real: accuracySlice(real), bench: accuracySlice(bench) },
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    providers,
  };
}

/** Reads the ledger read-only and aggregates it. Throws when the ledger does not exist yet. */
export function loadDashboardData(): DashboardData {
  const db = new Database(CONFIG.LEDGER_PATH, { readonly: true, fileMustExist: true });
  try {
    return computeDashboardData(db.prepare('SELECT * FROM events').all() as LedgerEvent[]);
  } finally {
    db.close();
  }
}
