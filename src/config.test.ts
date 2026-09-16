import { jest } from '@jest/globals';
import path from 'node:path';

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
    // @ts-ignore
    const module = await import('./config.js?t=blank-ledger');
    expect(path.isAbsolute(module.CONFIG.LEDGER_PATH)).toBe(true);
    expect(module.CONFIG.LEDGER_PATH).toBe(path.join(module.CONFIG.OUTPUT_DIR, 'ledger.sqlite'));
  });

  it('treats any blank variable as unset so its default applies', async () => {
    process.env.OLLAMA_HOST = '';
    process.env.DOWNSTREAM_MCP = '';
    // @ts-ignore
    const module = await import('./config.js?t=blank-generic');
    expect(module.CONFIG.OLLAMA_HOST).toBe('http://localhost:11434');
    expect(module.CONFIG.DOWNSTREAM_MCP).toBeNull();
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
    delete process.env.SUBSCRIPTION_PLAN;
    delete process.env.PLAN_CLAUDE;
    
    // @ts-ignore
    let module = await import('./config.js?t=1');
    expect(module.CONFIG.RESOLVED_PLAN_CLAUDE.plan).toBe('claude-pro');

    // 2. SUBSCRIPTION_PLAN overrides default
    process.env.SUBSCRIPTION_PLAN = 'claude-max-20x';
    // @ts-ignore
    module = await import('./config.js?t=2');
    expect(module.CONFIG.RESOLVED_PLAN_CLAUDE.plan).toBe('claude-max-20x');

    // 3. PLAN_CLAUDE overrides SUBSCRIPTION_PLAN
    process.env.PLAN_CLAUDE = 'claude-max-5x';
    // @ts-ignore
    module = await import('./config.js?t=3');
    expect(module.CONFIG.RESOLVED_PLAN_CLAUDE.plan).toBe('claude-max-5x');
  });
});
