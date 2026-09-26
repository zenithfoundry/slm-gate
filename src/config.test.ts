import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parse } from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
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

  it('puts the gate\'s Langfuse traffic in its own environment, not the shared default', async () => {
    // 'default' is where any other writer to the same project lands when it sets none.
    process.env.LANGFUSE_ENVIRONMENT = '';
    const { CONFIG } = await loadConfig('blank-langfuse-env');
    expect(CONFIG.LANGFUSE_ENVIRONMENT).toBe('slm-gate');
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

  it('leaves out SLM_GATE_HOME, so the automatically started model gate inherits it and reads the same .env', async () => {
    const { gateEnvironment } = await import('./setup/model-gate.js');
    expect(gateEnvironment({ SLM_GATE_HOME: '/data/slm-gate', SLM_GATE_MODEL: 'm', LEDGER_PATH: '/x', PATH: '/bin' }))
      .toEqual({ SLM_GATE_HOME: '/data/slm-gate', PATH: '/bin' });
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
    const envPath = path.join(CONFIG.HOME_DIR, '.env');
    const fromFile = fs.existsSync(envPath) ? parse(fs.readFileSync(envPath)).LLM_GATE_PORT : undefined;
    expect(CONFIG.LLM_GATE_PORT).toBe(9999);
    expect(CONFIG.MODEL_GATE_PORT).toBe(fromFile ? Number(fromFile) : 8787);
  });
});

describe('SLM_GATE_HOME', () => {
  const originalEnv = process.env;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-home-'));
    process.env = { ...originalEnv, SLM_GATE_HOME: home };
    // tests/setup-env.ts points LEDGER_PATH at a temp ledger; these tests check the default under HOME_DIR.
    delete process.env.LEDGER_PATH;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('reads .env from SLM_GATE_HOME and keeps output/ and the ledger there', async () => {
    fs.writeFileSync(path.join(home, '.env'), 'LLM_GATE_PORT=9123\n');
    const { CONFIG } = await loadConfig('home-env');
    expect(CONFIG.HOME_DIR).toBe(home);
    expect(CONFIG.OUTPUT_DIR).toBe(path.join(home, 'output'));
    expect(CONFIG.LEDGER_PATH).toBe(path.join(home, 'output', 'ledger.sqlite'));
    expect(CONFIG.MODEL_GATE_PORT).toBe(9123);
  });

  it('keeps the precedence: the host environment beats .env, and .env beats the defaults', async () => {
    fs.writeFileSync(path.join(home, '.env'), 'SLM_GATE_MODEL=from-env-file\nSLM_BRAIN_MODEL=brain-from-env-file\n');
    process.env.SLM_GATE_MODEL = 'from-host';
    delete process.env.SLM_BRAIN_MODEL;
    const { CONFIG } = await loadConfig('home-precedence');
    expect(CONFIG.SLM_GATE_MODEL).toBe('from-host');
    expect(CONFIG.SLM_BRAIN_MODEL).toBe('brain-from-env-file');
  });
});

describe('RAM_PRESET', () => {
  const originalEnv = process.env;
  let home: string;

  beforeEach(() => {
    // An empty settings folder, so no .env names the models and the preset picks them.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-ram-'));
    process.env = { ...originalEnv, SLM_GATE_HOME: home };
    for (const key of ['RAM_PRESET', 'SLM_BRAIN_MODEL', 'SLM_GATE_MODEL', 'SLM_GATE_TESTING_MODEL']) delete process.env[key];
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([16, 24, 32, 48, 64, 128, 192])('accepts what doctor recommends for %i GB of RAM, so following its advice cannot stop slm-gate', async ramGb => {
    const { recommendPreset } = await import('./hardware.js');
    process.env.RAM_PRESET = recommendPreset(ramGb);
    await expect(loadConfig(`ram-${ramGb}`)).resolves.toBeDefined();
  });

  it.each([
    ['ram-48', 'qwen3.5:9b', 'qwen2.5-coder:3b'],
    ['ram-64', 'qwen3.5:9b', 'qwen3.5:4b'],
    ['ram-128', 'qwen3:14b', 'qwen3:8b'],
  ])('%s picks its own models when .env names none', async (preset, brain, gate) => {
    process.env.RAM_PRESET = preset;
    const { CONFIG } = await loadConfig(`models-${preset}`);
    expect(CONFIG.SLM_BRAIN_MODEL).toBe(brain);
    expect(CONFIG.SLM_GATE_MODEL).toBe(gate);
  });

  it.each(['ram-4', 'ram-8', 'ram-12'])('rejects %s: slm-gate needs 16 GB of RAM or more', async preset => {
    process.env.RAM_PRESET = preset;
    await expect(loadConfig(`reject-${preset}`)).rejects.toThrow(/RAM_PRESET|Invalid enum/);
  });
});
