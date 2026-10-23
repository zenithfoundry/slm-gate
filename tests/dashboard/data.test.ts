import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { LedgerEvent } from '../../src/ledger/index.js';
import { clusterCycles, computeDashboardData } from '../../src/dashboard/data.js';
import { __resetProviderRegistry } from '../../src/pricing/providers.js';

const ev = (o: Partial<LedgerEvent>): LedgerEvent => ({
  ts: '2026-09-21T10:00:00.000Z',
  layer: 'mcp',
  request_id: Math.random().toString(36).slice(2),
  route: 'condition',
  is_local_call: 1,
  provider: 'claude',
  in_tok: 1000,
  out_tok: 200,
  api_in_tok: 0,
  api_out_tok: 0,
  cost_usd: 0,
  slm_latency_s: 1,
  api_latency_s: 0,
  slm_gate: 'on',
  ...o,
});

describe('dashboard tool-definition card data', () => {
  const llm = (tools: { count: number; deferred: number; tokEst: number }, ts: string) => ev({
    ts, layer: 'llm', route: 'forward_raw', is_local_call: 0,
    meta: JSON.stringify({ format: 'anthropic', tools_count: tools.count, tools_deferred: tools.deferred, tools_tok_est: tools.tokEst }),
  });

  it('warns when the latest request lists many tools and defers none', () => {
    const data = computeDashboardData([
      llm({ count: 30, deferred: 25, tokEst: 2000 }, '2026-09-21T10:00:00.000Z'),
      llm({ count: 30, deferred: 0, tokEst: 12000 }, '2026-09-21T11:00:00.000Z'),
    ]);
    expect(data.toolDefs.requests).toBe(2);
    expect(data.toolDefs.last).toEqual({ count: 30, deferred: 0, tokEst: 12000 });
    expect(data.toolDefs.warn).toBe(true);
  });

  it('does not warn when the latest request defers its tools', () => {
    const data = computeDashboardData([llm({ count: 30, deferred: 25, tokEst: 2000 }, '2026-09-21T10:00:00.000Z')]);
    expect(data.toolDefs.avgDeferred).toBe(25);
    expect(data.toolDefs.warn).toBe(false);
  });

  it('reports no requests when no row carries tool counts', () => {
    const data = computeDashboardData([ev({})]);
    expect(data.toolDefs).toEqual({ requests: 0, avgCount: null, avgDeferred: null, avgTokEst: null, last: null, warn: false });
  });
});

describe('dashboard skill fidelity card data', () => {
  const cond = (skill: string, fidelity: object, ts = '2026-09-21T10:00:00.000Z') => ev({ ts, skill, meta: JSON.stringify({ fidelity }) });

  it('averages recall and the deterministic pass rate over measured rows only, and lists the worst skills', () => {
    const data = computeDashboardData([
      cond('a', { mode: 'summarize', deterministic: 1, recall: 1 }),
      cond('b', { mode: 'summarize', deterministic: 0, recall: 0.5 }),
      cond('c', { mode: 'not_shrunk', deterministic: 1, recall: null }),
      cond('d', { mode: 'cache_hit' }),
      cond('e', { mode: 'verbatim', deterministic: 1, recall: null }),
      ev({ route: 'feedback', out_tok: 100, is_local_call: 0 }),
    ]);
    expect(data.fidelity.conditionings).toBe(5);
    expect(data.fidelity.measured).toBe(3);
    expect(data.fidelity.notShrunk).toBe(1);
    expect(data.fidelity.avgRecall).toBe(0.75);
    expect(data.fidelity.deterministicPassPct).toBe(66.7);
    expect(data.fidelity.expansionRate).toBe(0.2);
    expect(data.fidelity.worst.map(w => w.skill)).toEqual(['b', 'a']);
  });

  it('reports nothing measured when no row carries fidelity', () => {
    const data = computeDashboardData([ev({})]);
    expect(data.fidelity).toEqual({ conditionings: 0, measured: 0, avgRecall: null, deterministicPassPct: null, notShrunk: 0, expansionRate: 0, worst: [], learned: null });
  });

  it('passes the learned-protection count through when the loader supplies it', () => {
    expect(computeDashboardData([ev({})], { learnedProtections: 7 }).fidelity.learned).toBe(7);
  });
});

describe('dashboard day totals net expansions against savings', () => {
  it('shows 3000 saved for a day with one conditioning saving 5000 and one expansion of 2000', () => {
    const data = computeDashboardData([
      ev({ route: 'condition', in_tok: 6000, out_tok: 1000, ts: '2026-09-21T10:00:00.000Z' }),
      ev({ route: 'feedback', in_tok: 0, out_tok: 2000, is_local_call: 0, ts: '2026-09-21T10:05:00.000Z' }),
    ]);
    expect(data.days).toHaveLength(1);
    expect(data.days[0].tokensSaved).toBe(3000);
    expect(data.days[0].baselineTokens).toBe(6000);
  });
});

describe('dashboard cycle clustering', () => {
  beforeEach(() => {
    // 240,000 tokens per 300-minute window → 800 tokens saved = 1 minute. Round numbers on purpose.
    process.env.CLAUDE_WINDOW_BUDGET = '240000';
    __resetProviderRegistry();
  });
  afterEach(() => {
    delete process.env.CLAUDE_WINDOW_BUDGET;
    __resetProviderRegistry();
  });

  it('keeps events within the window in one cycle and opens a new one past it', () => {
    const cycles = clusterCycles({
      events: [
        ev({ ts: '2026-09-21T10:00:00.000Z' }),
        ev({ ts: '2026-09-21T10:01:00.000Z' }),
        ev({ ts: '2026-09-21T16:00:00.000Z' }), // 6h after the first: outside a 5h window
      ],
      windowMinutes: 300,
      providerId: 'claude',
    });
    expect(cycles.map(c => [c.start, c.events])).toEqual([
      ['2026-09-21T10:00:00.000Z', 2],
      ['2026-09-21T16:00:00.000Z', 1],
    ]);
  });

  it('converts a cycle\'s tokens saved into window minutes using the configured budget', () => {
    // condition saves in_tok - out_tok = 800 tokens → 1 minute of a 240k/300min window.
    const [cycle] = clusterCycles({ events: [ev({})], windowMinutes: 300, providerId: 'claude' });
    expect(cycle.tokensSaved).toBe(800);
    expect(cycle.minutes).toBe(1);
  });

  it('reports minutes as null, never 0, when the provider has no window budget', () => {
    delete process.env.CLAUDE_WINDOW_BUDGET;
    __resetProviderRegistry();
    const [cycle] = clusterCycles({ events: [ev({})], windowMinutes: 300, providerId: 'claude' });
    expect(cycle.minutes).toBeNull();
  });
});

describe('dashboard aggregates', () => {
  it('excludes old benchmark rows from savings and routing and only counts them', () => {
    const data = computeDashboardData([
      ev({ ts: '2026-09-21T10:00:00.000Z' }),
      ev({ ts: '2026-09-21T10:01:00.000Z', environment: 'bench', quality_score: 1 }),
    ]);
    expect(data.realEvents).toBe(1);
    expect(data.benchEvents).toBe(1);
    expect(data.days).toHaveLength(1);
    expect(data.days[0].events).toBe(1);
    expect(data.providers.find(p => p.id === 'claude')?.events).toBe(1);
  });

  it('counts routing decisions without feedback rows: a feedback click is not a routed prompt', () => {
    const data = computeDashboardData([
      ev({ route: 'condition' }),
      ev({ route: 'defer_local', layer: 'llm' }),
      ev({ route: 'feedback' }),
    ]);
    expect(data.routing).toEqual({ resolvedLocal: 1, distilledForwarded: 1, escalatedCloud: 0 });
    expect(data.days[0].events).toBe(3);
  });

  it('splits providers by the event\'s resolved provider', () => {
    const data = computeDashboardData([ev({}), ev({ provider: 'gemini' })]);
    expect(data.providers.find(p => p.id === 'claude')?.events).toBe(1);
    expect(data.providers.find(p => p.id === 'gemini')?.events).toBe(1);
    expect(data.providers.find(p => p.id === 'chatgpt')?.events).toBe(0);
  });

  it('rolls weeks up to Monday UTC', () => {
    const data = computeDashboardData([
      ev({ ts: '2026-09-20T23:00:00.000Z' }), // Sunday → week of Mon 09-14
      ev({ ts: '2026-09-21T01:00:00.000Z' }), // Monday → week of Mon 09-21
    ]);
    const weeks = data.providers.find(p => p.id === 'claude')!.weeks;
    expect(weeks.map(w => w.weekStart)).toEqual(['2026-09-14', '2026-09-21']);
  });
});
