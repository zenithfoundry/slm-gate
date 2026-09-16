import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';

// config.ts reads the environment once, at import time. A unique query string forces a
// fresh copy per call; building it at runtime keeps the compiler from resolving the path.
const loadConfig = (key: string | number) => import(`./config.js?t=${key}`) as Promise<typeof import('./config.js')>;

describe('Config blank-value handling', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('treats a blank LEDGER_PATH as unset and resolves the absolute default under OUTPUT_DIR', async () => {
    // Every shipped .env template carries `LEDGER_PATH=`; dotenv delivers that as ''. Before
    // the fix this defeated the zod default and the gate fell back to a cwd-relative path.
    process.env.LEDGER_PATH = '';
    const { CONFIG } = await loadConfig('blank-ledger');
    expect(path.isAbsolute(CONFIG.LEDGER_PATH)).toBe(true);
    expect(CONFIG.LEDGER_PATH).toBe(path.join(CONFIG.OUTPUT_DIR, 'ledger.sqlite'));
  });

  it('treats any blank variable as unset so its default applies', async () => {
    process.env.OLLAMA_HOST = '';
    process.env.DOWNSTREAM_MCP = '';
    const { CONFIG } = await loadConfig('blank-generic');
    expect(CONFIG.OLLAMA_HOST).toBe('http://localhost:11434');
    expect(CONFIG.DOWNSTREAM_MCP).toBeNull();
  });
});

describe('Config Plan Precedence', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('Test 6: Verify planId precedence (ENV PLAN overrides SUBSCRIPTION_PLAN)', async () => {
    // We isolate imports inside the test since config.js evaluates at import time.
    
    // 1. Base case: default plan
    // Blank, not deleted: config.ts loads the developer's .env on import, and dotenv only
    // fills variables that are missing. Deleting them let a real .env plan leak in.
    process.env.SUBSCRIPTION_PLAN = '';
    process.env.PLAN_CLAUDE = '';
    
    expect((await loadConfig(1)).CONFIG.RESOLVED_PLAN_CLAUDE.plan).toBe('claude-pro');

    // 2. SUBSCRIPTION_PLAN overrides default
    process.env.SUBSCRIPTION_PLAN = 'claude-max-20x';
    expect((await loadConfig(2)).CONFIG.RESOLVED_PLAN_CLAUDE.plan).toBe('claude-max-20x');

    // 3. PLAN_CLAUDE overrides SUBSCRIPTION_PLAN
    process.env.PLAN_CLAUDE = 'claude-max-5x';
    expect((await loadConfig(3)).CONFIG.RESOLVED_PLAN_CLAUDE.plan).toBe('claude-max-5x');
  });
});
