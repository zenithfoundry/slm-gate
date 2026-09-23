import type { LedgerEvent } from '../../src/ledger/index.js';
import { savingsByDay } from '../../src/ledger/report.js';

const conditioned = (o: Partial<LedgerEvent>): LedgerEvent => ({
  ts: '2026-09-21T10:00:00.000Z',
  layer: 'mcp',
  request_id: 'req',
  route: 'condition',
  is_local_call: 1,
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

describe('ledger:report savings by day', () => {
  const rows = savingsByDay([
    conditioned({ request_id: 'a', ts: '2026-09-21T23:59:59.000Z' }),
    conditioned({ request_id: 'b', ts: '2026-09-22T00:00:01.000Z', in_tok: 500, out_tok: 100 }),
    conditioned({ request_id: 'c', ts: '2026-09-22T12:00:00.000Z', environment: 'bench' }),
    conditioned({ request_id: 'd', ts: '2026-09-22T13:00:00.000Z', route: 'feedback' }),
  ]);

  it('splits days on UTC midnight and uses the per-event savings arithmetic', () => {
    expect(rows.map(r => [r.day, r.events, r.tokensSaved])).toEqual([
      ['2026-09-21', 1, 800],
      ['2026-09-22', 3, 400 + 800 + 0],
      ['all-time', 4, 2000],
    ]);
  });

  it('makes all-time exactly the sum of the day rows', () => {
    const days = rows.slice(0, -1);
    const total = rows[rows.length - 1];
    expect(total.tokensSaved).toBe(days.reduce((sum, r) => sum + r.tokensSaved, 0));
    expect(total.baselineTokens).toBe(days.reduce((sum, r) => sum + r.baselineTokens, 0));
  });

  it('shows benchmark savings separately so they can be told apart from real traffic', () => {
    expect(rows[1].benchTokensSaved).toBe(800);
  });
});
