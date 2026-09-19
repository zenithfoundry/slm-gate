import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { startFakeOllama } from './fake-ollama.js';

// Step A with the semantic cache on. Config is read once at import, so the env is set first.
const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
process.env.SEMCACHE = 'on';
process.env.LOCAL_ATTEMPT_BUDGET_MS = '300';
process.env.SELF_CONSISTENCY_K = '1';
process.env.ROUTING_TUNE = 'off';

const { answerFirstRequestLocally, attemptLocalAnswer } = await import('../../src/llm-gate/local-first.js');
const { initCacheDb } = await import('../../src/cache/index.js');
const { getDb } = await import('../../src/ledger/index.js');

afterAll(() => ollama.close());
beforeEach(() => {
  ollama.reset();
  initCacheDb();
  getDb().exec('DELETE FROM semcache');
});

describe('Step A with the semantic cache', () => {
  it('treats a broken cache entry as a miss and still answers', async () => {
    getDb().prepare('INSERT INTO semcache (id, embedding_blob, response, file_hashes, ts) VALUES (?, ?, ?, ?, ?)')
      .run('broken', Buffer.alloc(24), '{}', 'NOT-VALID-JSON{{{', new Date().toISOString());

    const attempt = await attemptLocalAnswer({ task: 'Say hi', messages: [{ role: 'user', content: 'Say hi' }], toolsListed: false });

    expect(attempt).toMatchObject({ answer: 'Hi! How can I help you today?', fromCache: false });
  });

  it('does not hold the one-attempt slot while a slow cache lookup outlives the budget', async () => {
    ollama.state.embedDelayMs = 3000;

    const first = await answerFirstRequestLocally({ task: 'Say hi', toolsListed: true });
    const second = await answerFirstRequestLocally({ task: 'Say hello', toolsListed: true });

    expect(first.outcome).toBe('timeout');
    expect(second.outcome).not.toBe('busy');
  });
});
