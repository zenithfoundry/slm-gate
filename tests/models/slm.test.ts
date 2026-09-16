import { z } from 'zod';
import { SLM } from '../../src/models/slm.js';
import { SlmFormatError } from '../../src/models/helpers.js';
import { checkAgreement, selfConsistency } from '../../src/models/reasoning.js';
import { Ollama } from 'ollama';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

describe('SLM Client', () => {
  let mockOllama: jest.Mocked<Ollama>;

  beforeEach(() => {
    mockOllama = {
      chat: jest.fn(),
      list: jest.fn(),
    } as any;
  });

  it('strips <think> tags before parsing JSON', async () => {
    const slm = new SLM(mockOllama);
    
    mockOllama.chat.mockResolvedValue({
      model: 'qwen',
      created_at: new Date(),
      message: { role: 'assistant', content: '<think>thinking process</think>\n{"result":"success"}' },
      done: true
    } as any);

    const schema = z.object({ result: z.string() });
    const res = await slm.generateJSON('qwen', 'prompt', schema);
    expect(res).toEqual({ result: 'success' });
  });

  it('throws SlmFormatError on invalid JSON after retry', async () => {
    const slm = new SLM(mockOllama);
    
    mockOllama.chat.mockResolvedValue({
      model: 'qwen',
      created_at: new Date(),
      message: { role: 'assistant', content: 'not json' },
      done: true
    } as any);

    const schema = z.object({ result: z.string() });
    
    await expect(slm.generateJSON('qwen', 'prompt', schema)).rejects.toThrow(SlmFormatError);
    expect(mockOllama.chat).toHaveBeenCalledTimes(2); // Initial try + 1 retry at temp=0
  });

  it('sends think at the request level, not inside options', async () => {
    // Regression guard. Ollama ignores unknown keys in `options`, so `think` placed there left
    // reasoning ENABLED: qwen3.5 spent the whole num_predict budget thinking and returned empty
    // content, failing every resolver call with `resolver_error: format`.
    const slm = new SLM(mockOllama);

    mockOllama.chat.mockResolvedValue({
      model: 'qwen',
      created_at: new Date(),
      message: { role: 'assistant', content: '{"result":"success"}' },
      done: true
    } as any);

    const schema = z.object({ result: z.string() });
    await slm.generateJSON('qwen', 'prompt', schema);

    const request = mockOllama.chat.mock.calls[0][0] as any;
    expect(request.think).toBe(false);
    expect(request.options).not.toHaveProperty('think');
  });

  it('caps generateText output only when the caller passes a ceiling', async () => {
    const slm = new SLM(mockOllama);

    mockOllama.chat.mockResolvedValue({
      model: 'qwen',
      created_at: new Date(),
      message: { role: 'assistant', content: 'summary' },
      done: true
    } as any);

    // Conversational proxying (llm-gate) must stay uncapped, or user answers get truncated.
    await slm.generateText('qwen', [{ role: 'user', content: 'p' }]);
    expect((mockOllama.chat.mock.calls[0][0] as any).options).not.toHaveProperty('num_predict');

    // Summarising callers (mcp-gate distill) bound the run so it cannot loop until the
    // context window fills.
    await slm.generateText('qwen', [{ role: 'user', content: 'p' }], 0, 1234);
    const capped = mockOllama.chat.mock.calls[1][0] as any;
    expect(capped.think).toBe(false);
    expect(capped.options.num_predict).toBe(1234);
  });

  it('checkAgreement normalizes strings and finds majority', () => {
    const samples = [
      'TRUE.',
      'true',
      ' false '
    ];
    expect(checkAgreement(samples)).toBe('TRUE.'); // First encountered that meets majority
  });
  
  it('checkAgreement returns null on tie', () => {
    const samples = [
      'true',
      'false'
    ];
    expect(checkAgreement(samples)).toBeNull();
  });
});
