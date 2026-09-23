import { jest } from '@jest/globals';

// Real SQLite in memory; only the network is stubbed. Keys must be present or flushQueue
// returns before sending anything.
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

const { getDb, LangfuseSink } = await import('../../src/ledger/index.js');

type BatchItem = { id: string; type: string; body: { id?: string; traceId?: string } };

const queueEvent = (requestId: string) => LangfuseSink.mirrorEvent({
  ts: '2026-09-23T10:00:00.000Z',
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

/** Answers every ingestion call with 207, rejecting the trace item of `badRequestId`. */
const rejectTraceOf = (badRequestId: string) =>
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const { batch } = JSON.parse(String(init?.body)) as { batch: BatchItem[] };
    const bad = batch.filter(item => item.type === 'trace-create' && item.body.id === badRequestId);
    return new Response(JSON.stringify({
      successes: batch.filter(item => !bad.includes(item)).map(item => ({ id: item.id, status: 201 })),
      errors: bad.map(item => ({ id: item.id, status: 400, message: 'Invalid request data' })),
    }), { status: 207 });
  });

const queuedTraceIds = () => (getDb().prepare('SELECT payload FROM langfuse_queue ORDER BY id').all() as { payload: string }[])
  .map(row => JSON.parse(row.payload).trace.id);

describe('LangfuseSink.flushQueue with a 207 partial acceptance', () => {
  beforeEach(() => {
    LangfuseSink.__resetForTests();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the row with a rejected item queued and deletes the accepted rows', async () => {
    const fetchSpy = rejectTraceOf('req_bad');
    queueEvent('req_ok_1');
    queueEvent('req_bad');
    queueEvent('req_ok_2');

    const shipped = await LangfuseSink.flushQueue();

    expect(shipped).toBe(2);
    expect(queuedTraceIds()).toEqual(['req_bad']);
    const row = getDb().prepare('SELECT attempts FROM langfuse_queue').get() as { attempts: number };
    expect(row.attempts).toBe(1);
    // The rejected row is not resent within the same flush.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('moves a row rejected on every flush to the dead-letter table and drains the queue', async () => {
    rejectTraceOf('req_bad');
    queueEvent('req_bad');

    for (let flush = 0; flush < 5; flush++) await LangfuseSink.flushQueue();

    expect(queuedTraceIds()).toEqual([]);
    const dead = getDb().prepare('SELECT payload, attempts, error FROM langfuse_dead_letter').all() as { payload: string; attempts: number; error: string }[];
    expect(dead).toHaveLength(1);
    expect(JSON.parse(dead[0].payload).trace.id).toBe('req_bad');
    expect(dead[0].attempts).toBe(5);
    expect(dead[0].error).toContain('Invalid request data');
  });

  it('keeps every row of the batch when an error cannot be matched to an item', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      successes: [],
      errors: [{ id: 'not-in-this-batch', status: 500, message: 'Internal error' }],
    }), { status: 207 }));
    queueEvent('req_a');
    queueEvent('req_b');

    const shipped = await LangfuseSink.flushQueue();

    expect(shipped).toBe(0);
    expect(queuedTraceIds()).toEqual(['req_a', 'req_b']);
  });
});
