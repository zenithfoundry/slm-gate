import { getE2EEnv } from '../../scripts/ollama-helper.js';

const LANGFUSE_KEYS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST'] as const;

describe('E2E runs never ship to the real Langfuse project', () => {
  // E2E runs write to a throwaway ledger. With the real keys they also shipped their events to
  // the live project, where they matched no ledger row: 20 such traces on 2026-09-15 and 09-19.
  const saved = Object.fromEntries(LANGFUSE_KEYS.map(k => [k, process.env[k]]));

  beforeEach(() => {
    // As on a developer machine: real keys in the environment the E2E script starts from.
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-real';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-real';
    process.env.LANGFUSE_HOST = 'https://us.cloud.langfuse.com';
  });

  afterEach(() => {
    for (const key of LANGFUSE_KEYS) process.env[key] = saved[key];
  });

  it.each(LANGFUSE_KEYS)('blanks %s even when the parent environment has a real value', key => {
    expect(getE2EEnv()[key]).toBe('');
  });

  it.each(LANGFUSE_KEYS)('blanks %s even when an override tries to set it', key => {
    expect(getE2EEnv({ [key]: 'set-by-override' })[key]).toBe('');
  });
});
