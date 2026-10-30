/**
 * @fileoverview Langfuse calls carry a timeout, and their answers are read through the shapes the gate relies
 * on: an answer of another shape is reported and treated as absent, never read field by field.
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

const { LangfuseSink } = await import('../../src/ledger/index.js');
const { ingestionResponse, metricsCountsResponse, readJson, traceListTotal } = await import('../../src/langfuse/api.js');

beforeEach(() => {
  LangfuseSink.__resetForTests();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('readJson', () => {
  it('returns the answer when it has the expected shape, unknown fields kept', async () => {
    const res = new Response(JSON.stringify({ meta: { totalItems: 7, page: 1 }, data: [] }), { status: 200 });
    expect(await readJson({ res, schema: traceListTotal, scope: 'test', what: 'traces' })).toMatchObject({ meta: { totalItems: 7, page: 1 } });
  });

  it('returns null and says where the shape differs', async () => {
    const res = new Response(JSON.stringify({ meta: { totalItems: 'seven' } }), { status: 200 });
    expect(await readJson({ res, schema: traceListTotal, scope: 'test', what: 'traces' })).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/warn \[test\] Langfuse traces answer has an unexpected shape status=200 path=meta\.totalItems/));
  });

  it('returns null quietly for a body that is not JSON', async () => {
    const res = new Response('<html>gateway timeout</html>', { status: 504 });
    expect(await readJson({ res, schema: ingestionResponse, scope: 'test', what: 'ingestion' })).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('accepts the metrics count as a string or a number', () => {
    expect(metricsCountsResponse.safeParse({ data: [{ name: 'verified', count_count: '3' }, { name: null, count_count: 1 }] }).success).toBe(true);
    expect(metricsCountsResponse.safeParse({ data: [{ name: 'verified' }] }).success).toBe(false);
  });
});

describe('LangfuseSink.flushQueue', () => {
  it('sends every ingestion request with a timeout signal', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    LangfuseSink.mirrorEvent({
      ts: '2026-09-23T10:00:00.000Z', layer: 'mcp', request_id: 'req_1', route: 'condition', is_local_call: 1,
      slm_model: 'qwen3.5:2b', in_tok: 10, out_tok: 2, api_in_tok: 0, api_out_tok: 0, cost_usd: 0, slm_latency_s: 1, api_latency_s: 0, slm_gate: 'on',
    });
    expect(await LangfuseSink.flushQueue()).toBe(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats an ingestion answer of another shape as accepted with no item errors, and says so', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ errors: 'none' }), { status: 207 }));
    LangfuseSink.mirrorEvent({
      ts: '2026-09-23T10:00:00.000Z', layer: 'mcp', request_id: 'req_2', route: 'condition', is_local_call: 1,
      slm_model: 'qwen3.5:2b', in_tok: 10, out_tok: 2, api_in_tok: 0, api_out_tok: 0, cost_usd: 0, slm_latency_s: 1, api_latency_s: 0, slm_gate: 'on',
    });
    expect(await LangfuseSink.flushQueue()).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ledger] Langfuse ingestion answer has an unexpected shape'));
  });
});
