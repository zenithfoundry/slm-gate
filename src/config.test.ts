import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parse } from 'dotenv';
import fs from 'node:fs';
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

describe('CONFIG_ENV_KEYS', () => {
  it('lists every setting the model gate must take from its own .env, and nothing else', async () => {
    const { CONFIG_ENV_KEYS } = await loadConfig('env-keys');
    expect(CONFIG_ENV_KEYS).toEqual(expect.arrayContaining(['LLM_GATE_PORT', 'LEDGER_PATH', 'OLLAMA_HOST', 'LLM_GATE_DISTILL', 'UPSTREAM_ANTHROPIC_URL']));
    expect(CONFIG_ENV_KEYS).not.toContain('PATH');
    expect(CONFIG_ENV_KEYS).not.toContain('HOME');
  });
});

describe('MODEL_GATE_PORT', () => {
  const originalEnv = process.env;
  afterAll(() => {
    process.env = originalEnv;
  });

  it("comes only from slm-gate's .env, so a port set in one tool's MCP env block cannot start a second gate", async () => {
    process.env = { ...originalEnv, LLM_GATE_PORT: '9999' };
    const { CONFIG } = await loadConfig('gate-port');
    const envPath = path.join(CONFIG.ROOT_DIR, '.env');
    const fromFile = fs.existsSync(envPath) ? parse(fs.readFileSync(envPath)).LLM_GATE_PORT : undefined;
    expect(CONFIG.LLM_GATE_PORT).toBe(9999);
    expect(CONFIG.MODEL_GATE_PORT).toBe(fromFile ? Number(fromFile) : 8787);
  });
});
