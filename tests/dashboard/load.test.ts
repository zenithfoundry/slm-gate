/**
 * @fileoverview `loadDashboardData` reads the ledger with the narrowed column list and still feeds every
 * section (routing, providers, days) from what it selects.
 */
import { describe, expect, it } from '@jest/globals';
import { loadDashboardData } from '../../src/dashboard/data.js';
import { writeEvent } from '../../src/ledger/index.js';

describe('loadDashboardData', () => {
  it('aggregates the rows it reads from the ledger', () => {
    writeEvent({
      ts: '2026-09-21T10:00:00.000Z',
      layer: 'mcp',
      request_id: 'dash_load_1',
      route: 'condition',
      is_local_call: 1,
      api_model: 'claude-sonnet-5',
      in_tok: 1000,
      out_tok: 200,
      api_in_tok: 0,
      api_out_tok: 0,
      cost_usd: 0,
      slm_latency_s: 1,
      api_latency_s: 0,
      slm_gate: 'on',
      meta: JSON.stringify({ fidelity: { mode: 'verbatim', deterministic: 1, recall: null, lost: [], runs: 0, runsChecked: 0, runsKept: 0, runsSkippedBudget: 0, errors: [], learnedProtected: 0, learnedNew: 0, elapsedMs: 1 } }),
    });

    const data = loadDashboardData();

    expect(data.realEvents).toBeGreaterThanOrEqual(1);
    expect(data.routing.distilledForwarded).toBeGreaterThanOrEqual(1);
    expect(data.days.some(d => d.day === '2026-09-21' && d.tokensSaved >= 800)).toBe(true);
    expect(data.providers.find(p => p.id === 'claude')?.events).toBeGreaterThanOrEqual(1);
    expect(data.fidelity.conditionings).toBeGreaterThanOrEqual(1);
  });
});
