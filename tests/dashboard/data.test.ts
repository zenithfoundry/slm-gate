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
  it('excludes benchmark events from savings and routing but keeps their accuracy, labelled bench', () => {
    const data = computeDashboardData([
      ev({ ts: '2026-09-21T10:00:00.000Z' }),
      ev({ ts: '2026-09-21T10:01:00.000Z', environment: 'bench', quality_score: 1 }),
    ]);
    expect(data.realEvents).toBe(1);
    expect(data.benchEvents).toBe(1);
    expect(data.days).toHaveLength(1);
    expect(data.days[0].events).toBe(1);
    expect(data.providers.find(p => p.id === 'claude')?.events).toBe(1);
    expect(data.accuracy.bench).toEqual({ avgPct: 100, n: 1 });
    expect(data.accuracy.real).toEqual({ avgPct: null, n: 0 });
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
