import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { parse } from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recommendNumCtx } from '../../src/hardware.js';
import { fillSettings, initSettings, settingsForRam } from '../../src/setup/init.js';

// The real template from this checkout: the same file an npm install ships.
const installDir = process.cwd();
const template = fs.readFileSync(path.join(installDir, '.env.example'), 'utf8');

let homeDir: string;

beforeEach(() => {
  homeDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-init-')), '.slm-gate');
});

afterEach(() => {
  fs.rmSync(path.dirname(homeDir), { recursive: true, force: true });
});

describe('initSettings', () => {
  it('creates the settings folder and a file set up for a 64 GB computer', () => {
    const result = initSettings({ installDir, homeDir, ramGb: 64 });
    expect(result).toMatchObject({ created: true, preset: 'ram-64', models: ['qwen3.5:9b', 'qwen3.5:4b'] });
    expect(parse(fs.readFileSync(result.envPath))).toMatchObject({
      RAM_PRESET: 'ram-64',
      SLM_BRAIN_MODEL: 'qwen3.5:9b',
      SLM_GATE_MODEL: 'qwen3.5:4b',
      SLM_GATE_TESTING_MODEL: 'qwen3.5:4b',
      NUM_CTX: String(recommendNumCtx(64)),
    });
  });

  it('assumes no coding tool, AI provider or toolbox, and keeps every other line of the template', () => {
    const { envPath } = initSettings({ installDir, homeDir, ramGb: 64 });
    const text = fs.readFileSync(envPath, 'utf8');
    const created = parse(text);
    const original = parse(template);
    const filled = settingsForRam(64).lines;
    for (const [key, value] of Object.entries(original)) {
      if (!(key in filled)) expect([key, created[key]]).toEqual([key, value]);
    }
    expect(text.split('\n')).toHaveLength(template.split('\n').length);
    expect(created).toMatchObject({ PROVIDER: '', DOWNSTREAM_MCP: '', TLS_ADAPTER: 'off', CLOUD_API_KEY: '' });
    expect(created.SUBSCRIPTION_PLAN ?? '').toBe('');
  });

  it('never replaces a settings file that already exists', () => {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.env'), 'MINE=1\n');
    const result = initSettings({ installDir, homeDir, ramGb: 64 });
    expect(result.created).toBe(false);
    expect(fs.readFileSync(result.envPath, 'utf8')).toBe('MINE=1\n');
  });

  (process.platform === 'win32' ? it.skip : it)('makes the file readable by its owner only, since it may later hold keys', () => {
    const { envPath } = initSettings({ installDir, homeDir, ramGb: 16 });
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });
});

describe('the file init writes', () => {
  const originalEnv = process.env;

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([8, 16, 24, 32, 64, 128])('starts slm-gate with the settings for %i GB of RAM', async ramGb => {
    const { preset, lines } = settingsForRam(ramGb);
    initSettings({ installDir, homeDir, ramGb });
    // Only the new file supplies these; LEDGER_PATH comes from tests/setup-env.ts.
    process.env = { ...originalEnv, SLM_GATE_HOME: homeDir };
    for (const key of Object.keys(lines)) delete process.env[key];
    // A unique query string loads a fresh copy of the configuration, which reads the environment once.
    const { CONFIG } = await import(`../../src/config.js?t=init-${ramGb}`);
    expect(CONFIG).toMatchObject({ HOME_DIR: homeDir, RAM_PRESET: preset, SLM_BRAIN_MODEL: lines.SLM_BRAIN_MODEL, SLM_GATE_MODEL: lines.SLM_GATE_MODEL });
  });
});

describe('fillSettings', () => {
  it('sets only the active line, leaving comments that mention the setting alone', () => {
    expect(fillSettings('# B=old example\nB=1\n', { B: '3' })).toBe('# B=old example\nB=3\n');
  });

  it('refuses a template where a setting is missing or repeated, rather than guess where it goes', () => {
    expect(() => fillSettings('A=1\n', { B: '2' })).toThrow(/0 B= lines/);
    expect(() => fillSettings('B=1\nB=2\n', { B: '3' })).toThrow(/2 B= lines/);
  });
});
