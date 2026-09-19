import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { startFakeOllama } from './fake-ollama.js';

// Config is read once at import, so the fake Ollama must be running and the env set first.
const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
process.env.LOCAL_ATTEMPT_BUDGET_MS = '400';
process.env.HEADLINE_STRICTNESS = '4';
process.env.SELF_CONSISTENCY_K = '3';
process.env.SEMCACHE = 'off';
process.env.ROUTING_TUNE = 'off';

const {
  answerFirstRequestLocally, asksAboutAssistant, attemptLocalAnswer, getCategorySuccessRate, mentionsWorkspace, servableCacheHit,
} = await import('../../src/llm-gate/local-first.js');
const { writeEvent } = await import('../../src/ledger/index.js');

afterAll(() => ollama.close());
beforeEach(() => ollama.reset());

const ask = (task: string, toolsListed = true) => attemptLocalAnswer({ task, messages: [{ role: 'user', content: task }], toolsListed });

describe('guards', () => {
  it('recognises questions about the workspace, including the ones the classifier mislabels', () => {
    for (const text of [
      'Is this repo using pnpm?', 'What does the function processPipeline do?', 'Does src/config.ts export CONFIG?',
      'Fix the typo in README.md', 'what does `run()` return', 'list what is in ./scripts', 'why does the build fail',
    ]) expect(mentionsWorkspace(text)).toBe(true);
    for (const text of ['Say hi', 'hello', 'What is the capital of Japan?', 'Convert this list to JSON: a, b, c']) {
      expect(mentionsWorkspace(text)).toBe(false);
    }
  });

  it('recognises questions about the assistant itself', () => {
    for (const text of ['Who are you?', 'What can you do?', 'What model are you?', 'are you claude?', 'Tell me about yourself', '/help']) {
      expect(asksAboutAssistant(text)).toBe(true);
    }
    for (const text of ['Say hi', 'What is the capital of Japan?']) expect(asksAboutAssistant(text)).toBe(false);
  });
});

describe('attemptLocalAnswer', () => {
  it('answers an eligible general question when the samples agree', async () => {
    const attempt = await ask('Say hi');

    expect(attempt).toMatchObject({ answer: 'Hi! How can I help you today?', accepted: true, attempted: true, category: 'short_factual' });
    expect(ollama.calls.map(call => call.kind)).toEqual(['classify', 'answer', 'answer', 'answer']);
  });

  it('asks the local model nothing when the text mentions the workspace or the assistant', async () => {
    expect((await ask('Is this repo using pnpm?')).answer).toBeNull();
    expect((await ask('Who are you?')).answer).toBeNull();
    expect(ollama.calls).toEqual([]);
  });

  it('with tools listed, attempts only general questions and formatting', async () => {
    ollama.state.category = 'boolean';
    const attempt = await ask('Is it usually cold in January?');

    expect(attempt).toMatchObject({ answer: null, attempted: false, category: 'boolean' });
    expect(ollama.calls.map(call => call.kind)).toEqual(['classify']);
  });

  it('without tools, the wider allow list applies', async () => {
    ollama.state.category = 'boolean';
    ollama.state.answer = 'Yes.';
    expect((await ask('Is it usually cold in January?', false)).answer).toBe('Yes.');
  });

  it('sends no answer the verifier rejects', async () => {
    ollama.state.answer = "I'm not sure, possibly Tokyo.";
    const attempt = await ask('What is the capital of Japan?');

    expect(attempt).toMatchObject({ answer: null, attempted: true, accepted: false });
    expect(attempt.verifierFlags).toContain('hedging');
  });

  it('returns no answer when the local model is unavailable', async () => {
    ollama.state.status = 500;
    expect((await ask('Say hi')).answer).toBeNull();
  });
});

describe('semantic cache hits', () => {
  it('serve only answers that would be eligible now', () => {
    expect(servableCacheHit('old cloud answer', false)).toBe('old cloud answer');
    expect(servableCacheHit('old cloud answer', true)).toBeNull();
    expect(servableCacheHit({ answer: 'Tokyo', category: 'short_factual' }, true)).toBe('Tokyo');
    expect(servableCacheHit({ answer: 'fixed', category: 'trivial_edit' }, true)).toBeNull();
    expect(servableCacheHit({ answer: 'fixed', category: 'trivial_edit' }, false)).toBe('fixed');
    expect(servableCacheHit(null, false)).toBeNull();
  });
});

describe('ROUTING_TUNE success rate', () => {
  it('counts only attempts from the same environment', () => {
    const seed = (environment: string, accepted: boolean) => writeEvent({
      ts: new Date().toISOString(), layer: 'llm', request_id: `rt_${Math.random()}`, route: 'forward_raw', is_local_call: 0,
      in_tok: 0, out_tok: 0, api_in_tok: 0, api_out_tok: 0, cost_usd: 0, slm_latency_s: 0, api_latency_s: 0, slm_gate: 'on',
      environment, meta: JSON.stringify({ category: 'rt_probe', local_attempted: 1, local_accepted: accepted ? 1 : 0 }),
    });
    for (let i = 0; i < 4; i++) seed('bench', false);
    for (let i = 0; i < 4; i++) seed('default', true);

    expect(getCategorySuccessRate({ category: 'rt_probe', window: 20, minSamples: 4, environment: 'default' })).toBe(1);
    expect(getCategorySuccessRate({ category: 'rt_probe', window: 20, minSamples: 4, environment: 'bench' })).toBe(0);
    expect(getCategorySuccessRate({ category: 'rt_probe', window: 20, minSamples: 4, environment: null })).toBe(0.5);
  });
});

describe('answerFirstRequestLocally', () => {
  it('cancels an attempt at the budget, so the local model stops working on it', async () => {
    ollama.state.delayMs = 5000;
    const started = Date.now();

    const result = await answerFirstRequestLocally({ task: 'Say hi', toolsListed: true });

    expect(result.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
    await new Promise(resolve => setTimeout(resolve, 100));
    const answers = ollama.calls.filter(call => call.kind === 'answer');
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every(call => call.aborted)).toBe(true);
  });

  it('sends a first request on at once while another attempt is running', async () => {
    ollama.state.delayMs = 300;
    const first = answerFirstRequestLocally({ task: 'Say hi', toolsListed: true });
    const second = await answerFirstRequestLocally({ task: 'Say hello', toolsListed: true });

    expect(second.outcome).toBe('busy');
    expect((await first).outcome).toBe('answered');
  });
});
