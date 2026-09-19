import { jest, describe, beforeAll, beforeEach, it, expect } from '@jest/globals';
import { InternalRequest } from '../../src/llm-gate/formats/internal.js';
import { writeEvent } from '../../src/ledger/index.js';

let mockConfig = {
  SLM_BRAIN_MODEL: 'qwen-test',
  SLM_GATE_MODEL: 'qwen-gate-test',
  CLOUD_MODEL: 'gpt-5.6-sol',
  CLOUD_API_STYLE: 'openai',
  HEADLINE_STRICTNESS: 1,
  TEMPERATURE: 0,
  ROUTING_TUNE: true,
  ROUTING_TUNE_WINDOW: 10,
  ROUTING_TUNE_MIN_SAMPLES: 5,
  ROUTING_TUNE_THRESHOLD: 0.5,
  ROUTING_TUNE_EXPLORE_RATE: 0.0,
};

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: new Proxy({}, { get: (_, prop) => (mockConfig as any)[prop] })
}));

jest.unstable_mockModule('../../src/models/reasoning.js', () => ({
  classify: jest.fn(() => Promise.resolve('extract'))
}));

jest.unstable_mockModule('../../src/verifier/index.js', () => ({
  verify: jest.fn(() => ({ flags: [], escalate: false }))
}));

jest.unstable_mockModule('../../src/models/slm.js', () => ({
  SLM: jest.fn().mockImplementation(() => ({
    generateText: jest.fn(() => Promise.resolve('Local answer text'))
  }))
}));

describe('Outcome-Driven Routing (LLM Gate)', () => {
  let processPipeline: any;
  let getDb: any;

  beforeAll(async () => {
    // Dynamic imports after mocks
    const pipeline = await import('../../src/llm-gate/pipeline.js');
    processPipeline = pipeline.processPipeline;
    const ledger = await import('../../src/ledger/index.js');
    getDb = ledger.getDb;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM events').run();
    
    // Reset config for each test
    mockConfig.ROUTING_TUNE = true;
    mockConfig.ROUTING_TUNE_WINDOW = 10;
    mockConfig.ROUTING_TUNE_MIN_SAMPLES = 5;
    mockConfig.ROUTING_TUNE_THRESHOLD = 0.5;
    mockConfig.ROUTING_TUNE_EXPLORE_RATE = 0.0;
  });

  function seedEvents(category: string, attempted: boolean, accepted: boolean, count: number) {
    for (let i = 0; i < count; i++) {
      writeEvent({
        ts: new Date().toISOString(),
        layer: 'llm',
        request_id: `req_${Math.random()}`,
        route: accepted ? 'defer_local' : 'forward_compressed',
        is_local_call: attempted ? 1 : 0,
        in_tok: 10,
        out_tok: 10,
        api_in_tok: 10,
        api_out_tok: 10,
        cost_usd: 0,
        slm_latency_s: 1,
        api_latency_s: 1,
        slm_gate: 'on',
        meta: JSON.stringify({ category, local_attempted: attempted ? 1 : 0, local_accepted: accepted ? 1 : 0 })
      } as any);
    }
  }

  const req: InternalRequest = {
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'extract this' }]
  };

  it('(a) Disabled path: low success rate escalates immediately', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        choices: [{ message: { content: 'Cloud answer' } }]
      })
    })) as any;

    // Seed 10 attempts, 8 failures -> 20% success rate
    seedEvents('extract', true, false, 8);
    seedEvents('extract', true, true, 2);

    const result = await processPipeline('r1', req, { routePolicy: 'auto' });
    
    expect(result.localAttempted).toBe(false);
    expect(result.route).toBe('forward_compressed');
  });

  it('(b) Recovery/exploration: exploration bypasses disabled status', async () => {
    seedEvents('extract', true, false, 10);
    
    mockConfig.ROUTING_TUNE_EXPLORE_RATE = 1.0; // Force exploration
    
    const result = await processPipeline('r2', req, { routePolicy: 'auto' });
    
    expect(result.localAttempted).toBe(true);
    expect(result.route).toBe('defer_local');
  });

  it('(c) Fail-open: fewer than minSamples keeps it eligible', async () => {
    seedEvents('extract', true, false, 4);

    const result = await processPipeline('r3', req, { routePolicy: 'auto' });
    
    expect(result.localAttempted).toBe(true);
    expect(result.route).toBe('defer_local');
  });

  it('(d) Kill-switch: ROUTING_TUNE=off ignores ledger', async () => {
    seedEvents('extract', true, false, 10);
    
    mockConfig.ROUTING_TUNE = false;

    const result = await processPipeline('r4', req, { routePolicy: 'auto' });
    
    expect(result.localAttempted).toBe(true);
    expect(result.route).toBe('defer_local');
  });
});
