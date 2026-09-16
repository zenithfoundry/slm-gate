import { jest } from '@jest/globals';

// Kept apart from distill.test.ts because the adaptive branch needs the ledger and the embedding
// backend mocked, and the main suite exercises the real ledger.
jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    DISTILL_MIN_TOKENS: 0,
    DISTILL_MAX_TOKENS: 0,
    DISTILL_ADAPTIVE: true,
    DISTILL_ADAPTIVE_EXPLORE_RATE: 0.15,
    DISTILL_ADAPTIVE_THRESHOLD: 0.86,
    PROMPT_VERSION: 'test',
  },
}));

jest.unstable_mockModule('../../src/ledger/index.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined, run: () => undefined }) }),
  writeElision: () => undefined,
  getDistillPolicy: () => 'summarize',
  getDistillFeedback: () => [{ embedding_blob: Buffer.alloc(0) }],
}));

const embedText = jest.fn(async (_line: string) => [1, 0]);
jest.unstable_mockModule('../../src/utils/embedding.js', () => ({
  embedText,
  cosineSimilarity: () => 1,
  bufferToFloat64Array: () => [1, 0],
}));

const { distillToolResult } = await import('../../src/utils/elision.js');

describe('distill adaptive sampling', () => {
  const slm = jest.fn(async (t: string) => t.slice(0, 30));
  const lines = Array.from({ length: 10 }, (_, i) =>
    `Line ${i} is ordinary prose long enough to be eligible for the adaptive check.`);
  const text = lines.join('\n');
  const consoleMethods = ['info', 'warn', 'error'] as const;
  const originals = {} as Record<(typeof consoleMethods)[number], any>;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const m of consoleMethods) {
      originals[m] = console[m];
      console[m] = jest.fn();
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const m of consoleMethods) console[m] = originals[m];
  });

  it('embeds only the sampled fraction of lines: a draw above the explore rate is skipped', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);

    await distillToolResult(slm as any, text, undefined, undefined, undefined, []);

    expect(embedText).not.toHaveBeenCalled();
    expect(slm).toHaveBeenCalled();
  });

  it('a draw below the explore rate is embedded, and a match protects the line from the model', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.1);

    const result = await distillToolResult(slm as any, text, undefined, undefined, undefined, []);

    expect(embedText).toHaveBeenCalledTimes(lines.length);
    expect(slm).not.toHaveBeenCalled();
    expect(result).toBe(text);
  });
});
