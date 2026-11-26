import { afterAll, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A settings folder of its own, so the test does not depend on (or read) anybody's real .env.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-env-'));
fs.writeFileSync(path.join(home, '.env'), 'SLM_GATE_MODEL=from-file\nSLM_BRAIN_MODEL=same-in-both\nEMBED_MODEL=only-in-file\n');
const saved = { SLM_GATE_HOME: process.env.SLM_GATE_HOME, SLM_GATE_MODEL: process.env.SLM_GATE_MODEL, SLM_BRAIN_MODEL: process.env.SLM_BRAIN_MODEL, EMBED_MODEL: process.env.EMBED_MODEL, CLOUD_MODEL: process.env.CLOUD_MODEL };
Object.assign(process.env, { SLM_GATE_HOME: home, SLM_GATE_MODEL: 'from-env-block', SLM_BRAIN_MODEL: 'same-in-both' });
delete process.env.EMBED_MODEL;
delete process.env.CLOUD_MODEL;

const { CONFIG } = await import('../../src/config.js');

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('CONFIG.SET_IN_ENVIRONMENT', () => {
  it('lists a setting the environment gives a different value than .env', () => {
    expect(CONFIG.SLM_GATE_MODEL).toBe('from-env-block');
    expect(CONFIG.SET_IN_ENVIRONMENT).toContain('SLM_GATE_MODEL');
  });

  it('leaves out a setting only .env sets, one whose value matches .env, and one nobody set', () => {
    expect(CONFIG.EMBED_MODEL).toBe('only-in-file');
    expect(CONFIG.SET_IN_ENVIRONMENT).not.toContain('EMBED_MODEL');
    expect(CONFIG.SET_IN_ENVIRONMENT).not.toContain('SLM_BRAIN_MODEL');
    expect(CONFIG.SET_IN_ENVIRONMENT).not.toContain('CLOUD_MODEL');
  });
});
