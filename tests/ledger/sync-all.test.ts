/**
 * @fileoverview `ledger:sync --all` sends every historical event: it wins over --limit and --after.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '', LANGFUSE_HOST: '', LANGFUSE_ENVIRONMENT: 'test',
    PROVIDER: undefined,
    RESOLVED_PLAN_CLAUDE: { windowMinutes: 300, plan: 'claude-pro', windowBudget: null },
    RESOLVED_PLAN_CHATGPT: { windowMinutes: 180, plan: 'chatgpt-plus', windowBudget: null },
    RESOLVED_PLAN_GEMINI: { windowMinutes: 300, plan: 'gemini-ultra', windowBudget: null },
    ELISION_RETENTION_DAYS: 180,
  },
  requireKeys: () => undefined,
}));

const { writeEvent } = await import('../../src/ledger/index.js');
const { syncLedgerToLangfuse } = await import('../../src/ledger/sync.js');

const event = (id: string) => writeEvent({
  ts: '2026-09-23T10:00:00.000Z', layer: 'mcp', request_id: id, route: 'condition', is_local_call: 1,
  in_tok: 100, out_tok: 10, api_in_tok: 0, api_out_tok: 0, cost_usd: 0, slm_latency_s: 1, api_latency_s: 0, slm_gate: 'on',
});

describe('syncLedgerToLangfuse --all', () => {
  beforeEach(() => {
    for (const name of ['log', 'error', 'warn'] as const) jest.spyOn(console, name).mockImplementation(() => {});
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    event('sync_all_1');
    event('sync_all_2');
    event('sync_all_3');
  });

  afterEach(() => jest.restoreAllMocks());

  it('takes every event even when --limit and --after would narrow the run', async () => {
    const narrowed = await syncLedgerToLangfuse({ dryRun: true, limit: 1, after: 1 });
    expect(narrowed.totalEvents).toBe(1);

    const all = await syncLedgerToLangfuse({ dryRun: true, limit: 1, after: 1, all: true });
    expect(all.totalEvents).toBe(3);
  });
});
