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
    const res = await slm.generateJSON({ model: 'qwen', prompt: 'prompt', schema });
    expect(res).toEqual({ result: 'success' });
  });

  it('retries malformed JSON once at temperature 0 when the call was sampled', async () => {
    const slm = new SLM(mockOllama);

    mockOllama.chat.mockResolvedValue({
      model: 'qwen',
      created_at: new Date(),
      message: { role: 'assistant', content: 'not json' },
      done: true
    } as any);

    const schema = z.object({ result: z.string() });

    await expect(slm.generateJSON({ model: 'qwen', prompt: 'prompt', schema, temperature: 0.7 })).rejects.toThrow(SlmFormatError);
    expect(mockOllama.chat).toHaveBeenCalledTimes(2); // Initial try + 1 retry at temp=0
    expect((mockOllama.chat.mock.calls[0][0] as any).options.temperature).toBe(0.7);
    expect((mockOllama.chat.mock.calls[1][0] as any).options.temperature).toBe(0);
  });

  it('does not retry malformed JSON when the call was already at temperature 0', async () => {
    // The identical request would get the identical answer: a second call only costs another timeout.
    const slm = new SLM(mockOllama);

    mockOllama.chat.mockResolvedValue({
      model: 'qwen',
      created_at: new Date(),
      message: { role: 'assistant', content: 'not json' },
      done: true
    } as any);

    const schema = z.object({ result: z.string() });

    await expect(slm.generateJSON({ model: 'qwen', prompt: 'prompt', schema, temperature: 0 })).rejects.toThrow(SlmFormatError);
    expect(mockOllama.chat).toHaveBeenCalledTimes(1);
  });

  it('sends every Ollama request with an abort signal, so a timed-out generation is cancelled', async () => {
    // The ollama client itself passes no signal on a plain chat; without one, a generation the gate gave
    // up on kept the GPU busy until it finished on its own.
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: { role: 'assistant', content: 'hi' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    try {
      const slm = new SLM();
      await slm.generateText({ model: 'qwen', messages: [{ role: 'user', content: 'p' }] });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      fetchSpy.mockRestore();
    }
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
    await slm.generateJSON({ model: 'qwen', prompt: 'prompt', schema });

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
    await slm.generateText({ model: 'qwen', messages: [{ role: 'user', content: 'p' }] });
    expect((mockOllama.chat.mock.calls[0][0] as any).options).not.toHaveProperty('num_predict');

    // Summarising callers (mcp-gate distill) bound the run so it cannot loop until the
    // context window fills.
    await slm.generateText({ model: 'qwen', messages: [{ role: 'user', content: 'p' }], temperature: 0, maxTokens: 1234 });
    const capped = mockOllama.chat.mock.calls[1][0] as any;
    expect(capped.think).toBe(false);
    expect(capped.options.num_predict).toBe(1234);
  });

  it('selfConsistency asks its samples one after another, never concurrently', async () => {
    // Ollama serves one request at a time; samples fired together waited out their timeout in its queue.
    let inFlight = 0;
    let maxInFlight = 0;
    const slm = {
      generateJSON: jest.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight--;
        return { answer: 'yes' };
      }),
    } as unknown as SLM;

    const result = await selfConsistency({ slm, model: 'qwen', prompt: 'prompt', schema: z.object({ answer: z.string() }), k: 3, temperature: 0.7 });

    expect(result).toEqual({ answer: 'yes' });
    expect((slm.generateJSON as jest.Mock).mock.calls).toHaveLength(3);
    expect(maxInFlight).toBe(1);
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
