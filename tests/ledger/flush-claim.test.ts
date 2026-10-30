/**
 * @fileoverview The Langfuse queue is flushed by both gates: a flush claims its rows so a concurrent flush
 * sends nothing twice, and a batch Langfuse never accepted is released for the next flush.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    LANGFUSE_PUBLIC_KEY: 'pk-test',
    LANGFUSE_SECRET_KEY: 'sk-test',
    LANGFUSE_HOST: 'http://langfuse.invalid',
    LANGFUSE_ENVIRONMENT: 'test',
    PROVIDER: undefined,
  },
}));
// No real backoff sleeps between the retries of a failed batch.
jest.unstable_mockModule('../../src/utils/backoff.js', () => ({ waitWithBackoff: async () => undefined, LANGFUSE_REQUEST_TIMEOUT_MS: 1000 }));

const { getDb, LangfuseSink } = await import('../../src/ledger/index.js');

const queueEvent = (requestId: string) => LangfuseSink.mirrorEvent({
  ts: '2026-09-23T10:00:00.000Z',
  layer: 'mcp',
  request_id: requestId,
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
});

const queueRows = () => getDb().prepare('SELECT synced, claimed_at FROM langfuse_queue ORDER BY id').all() as { synced: number; claimed_at: string | null }[];

describe('LangfuseSink.flushQueue claims', () => {
  beforeEach(() => {
    LangfuseSink.__resetForTests();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends each row once when two flushes overlap', async () => {
    let answer: (() => void) | undefined;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => {
      answer = () => resolve(new Response(JSON.stringify({ successes: [], errors: [] }), { status: 200 }));
    }));
    queueEvent('req_1');
    queueEvent('req_2');

    const first = LangfuseSink.flushQueue();
    // The first flush has claimed its batch and is waiting on the network: a second flush finds nothing.
    await new Promise(resolve => setImmediate(resolve));
    expect(queueRows().map(r => r.synced)).toEqual([1, 1]);
    expect(await LangfuseSink.flushQueue()).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    answer!();
    expect(await first).toBe(2);
    expect(queueRows()).toEqual([]);
  });

  it('releases the claim when the batch was never accepted', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    queueEvent('req_1');

    expect(await LangfuseSink.flushQueue()).toBe(0);

    expect(queueRows()).toEqual([{ synced: 0, claimed_at: null }]);
  });
});
