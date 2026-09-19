import { jest } from '@jest/globals';
import { InternalRequest } from '../../src/llm-gate/formats/internal.js';

// Mock dependencies
jest.unstable_mockModule('../../src/models/slm.js', () => ({
  SLM: jest.fn().mockImplementation(() => ({
    generateJSON: jest.fn(() => Promise.resolve({ category: 'short_factual' })),
    generateText: jest.fn(() => Promise.resolve('Local answer text'))
  }))
}));

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    SLM_BRAIN_MODEL: 'qwen-test',
    SLM_GATE_MODEL: 'qwen-gate-test',
    SLM_GATE_TESTING_MODEL: 'qwen-gate-test',
    CLOUD_MODEL: 'gpt-5.6-sol',
    CLOUD_API_STYLE: 'openai',
    HEADLINE_STRICTNESS: 1,
    TEMPERATURE: 0
  }
}));

describe('Pipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defers locally and returns $0 cost', async () => {
    const { processPipeline } = await import('../../src/llm-gate/pipeline.js');
    
    const req: InternalRequest = {
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'What is 2+2?' }]
    };

    const res = await processPipeline('req-1', req, { routePolicy: 'auto' });
    expect(res.route).toBe('defer_local');
    expect(res.costUsd).toBe(0);
    expect(res.isLocal).toBe(true);
    expect(res.body.choices[0].message.content).toBe('Local answer text');
  });

  it('forwards raw if requested', async () => {
    const { processPipeline } = await import('../../src/llm-gate/pipeline.js');

    // Mock global fetch
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: async () => ({
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        choices: [{ message: { content: 'Cloud answer' } }]
      })
    })) as any;

    const req: InternalRequest = {
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'Complex question' }]
    };

    const res = await processPipeline('req-2', req, { routePolicy: 'raw' });
    expect(res.route).toBe('forward_raw');
    expect(res.isLocal).toBe(false);
    expect(res.costUsd).toBeGreaterThan(0); // we mocked token usage
    expect(res.body.choices[0].message.content).toBe('Cloud answer');
  });
});
