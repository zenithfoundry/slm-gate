import { expectedScoreCounts, parseWindow, scoreDeltas } from '../../src/ledger/verify.js';
import type { LedgerEvent } from '../../src/ledger/index.js';

const mcpEvent = (requestId: string): LedgerEvent => ({
  ts: '2026-09-21T10:00:00.000Z',
  layer: 'mcp',
  request_id: requestId,
  route: 'condition',
  is_local_call: 1,
  slm_model: 'qwen2.5-coder:3b',
  in_tok: 1000,
  out_tok: 200,
  api_in_tok: 0,
  api_out_tok: 0,
  cost_usd: 0,
  slm_latency_s: 1,
  api_latency_s: 0,
  slm_gate: 'on',
});

describe('ledger:verify window', () => {
  it('includes both named days and ends at the start of the day after --to', () => {
    expect(parseWindow(['--from', '2026-09-20', '--to', '2026-09-23'])).toEqual({
      from: '2026-09-20T00:00:00.000Z',
      to: '2026-09-24T00:00:00.000Z',
    });
  });

  it('rejects a missing or malformed date instead of guessing a window', () => {
    expect(() => parseWindow(['--from', '2026-09-20'])).toThrow('--to YYYY-MM-DD is required');
    expect(() => parseWindow(['--from', '20-09-2026', '--to', '2026-09-23'])).toThrow('--from YYYY-MM-DD is required');
  });

  it('rejects a window that ends before it starts', () => {
    expect(() => parseWindow(['--from', '2026-09-23', '--to', '2026-09-20'])).toThrow('--to is before --from');
  });
});

describe('ledger:verify score comparison', () => {
  it('expects one verified score per event and no accuracy score when the verifier never ran', () => {
    const expected = expectedScoreCounts([mcpEvent('a'), mcpEvent('b')]);
    expect(expected.get('verified')).toBe(2);
    expect(expected.get('tokens_saved')).toBe(2);
    expect(expected.has('accuracy_rate_pct')).toBe(false);
  });

  it('labels a retired score name as safe to ignore instead of leaving an unexplained surplus', () => {
    const rows = scoreDeltas({
      expected: new Map([['verified', 3]]),
      actual: new Map([['verified', 3], ['cycle_extended_per_window_claude', 5]]),
    });
    expect(rows).toEqual([
      { name: 'cycle_extended_per_window_claude', expected: 0, actual: 5, delta: 5, note: 'retired name, safe to ignore' },
      { name: 'verified', expected: 3, actual: 3, delta: 0, note: '' },
    ]);
  });

  it('flags an unknown score name the ledger does not explain', () => {
    const [row] = scoreDeltas({ expected: new Map(), actual: new Map([['mystery_score', 2]]) });
    expect(row.note).toBe('not written by this build');
  });
});
