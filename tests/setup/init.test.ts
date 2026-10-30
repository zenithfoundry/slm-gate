import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { parse } from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recommendNumCtx } from '../../src/hardware.js';
import { PROFILES, fillSettings, initSettings, settingsFor, settingsForRam } from '../../src/setup/init.js';

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
    // Just the pair: the template leaves the embedding model's features off.
    expect(result).toMatchObject({ created: true, preset: 'ram-64', models: ['qwen3.5:4b', 'qwen3.5:9b'] });
    expect(parse(fs.readFileSync(result.envPath))).toMatchObject({
      RAM_PRESET: 'ram-64',
      SLM_BRAIN_MODEL: 'qwen3.5:9b',
      SLM_GATE_MODEL: 'qwen3.5:4b',
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

  it('sets up more than 128 GB as custom, starting from the 128 GB models', () => {
    const result = initSettings({ installDir, homeDir, ramGb: 192 });
    expect(result).toMatchObject({ created: true, preset: 'custom', models: ['qwen3:8b', 'qwen3:14b'] });
    expect(parse(fs.readFileSync(result.envPath))).toMatchObject({ RAM_PRESET: 'custom', SLM_BRAIN_MODEL: 'qwen3:14b', SLM_GATE_MODEL: 'qwen3:8b' });
  });

  it('refuses a computer with less than 16 GB of RAM and writes nothing', () => {
    expect(() => initSettings({ installDir, homeDir, ramGb: 8 })).toThrow(/needs at least 16 GB/);
    expect(fs.existsSync(path.join(homeDir, '.env'))).toBe(false);
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

  it('writes the provider when one was chosen', () => {
    const { envPath } = initSettings({ installDir, homeDir, ramGb: 24, provider: 'claude' });
    expect(parse(fs.readFileSync(envPath))).toMatchObject({ PROVIDER: 'claude', RAM_PRESET: 'ram-24' });
  });
});

describe('profiles', () => {
  it('starter is the template as shipped: no third model, no toolbox, the adapter off', () => {
    const { envPath } = initSettings({ installDir, homeDir, ramGb: 24, profile: 'starter' });
    expect(parse(fs.readFileSync(envPath))).toMatchObject({ DISTILL_ADAPTIVE: 'off', DOWNSTREAM_MCP: '', TLS_ADAPTER: 'off', DISTILL_SKILLS: 'off' });
  });

  it('proven sets the three lines of the maintainer\'s setup and nothing else beyond the RAM lines', () => {
    const { lines } = settingsFor({ ramGb: 24, profile: 'proven' });
    expect(lines).toEqual({ ...settingsForRam(24).lines, DISTILL_SKILLS: 'on', REPO_INDEX: 'on', SELF_CONSISTENCY_K: '1' });
    const { envPath } = initSettings({ installDir, homeDir, ramGb: 24, profile: 'proven' });
    expect(parse(fs.readFileSync(envPath))).toMatchObject({ DISTILL_SKILLS: 'on', REPO_INDEX: 'on', SELF_CONSISTENCY_K: '1', DISTILL_ADAPTIVE: 'off' });
  });

  it('toolbox is proven with tech-lead-stack behind the MCP gate, so doctor\'s adapter rule holds', () => {
    const { lines } = settingsFor({ ramGb: 24, profile: 'toolbox' });
    expect(lines).toMatchObject(PROFILES.proven.lines);
    expect(lines.TLS_ADAPTER).toBe('on');
    expect(JSON.parse(lines.DOWNSTREAM_MCP)).toMatchObject({ command: 'npx' });
    expect(lines.DISTILL_PRESERVE_PATH).toBe('configs/preserve/tls.json');
  });

  it('every profile line names a setting the template has, so init can set it', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(() => fillSettings(template, profile.lines)).not.toThrow();
    }
  });
});

describe('the file init writes', () => {
  const originalEnv = process.env;

  afterAll(() => {
    process.env = originalEnv;
  });

  it.each([16, 24, 32, 48, 64, 128, 192])('starts slm-gate with the settings for %i GB of RAM', async ramGb => {
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
