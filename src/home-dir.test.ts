import { describe, expect, it } from '@jest/globals';
import path from 'node:path';
import { resolveHomeDir } from './home-dir.js';

const userHome = '/Users/someone';
const clone = '/Users/someone/projects/small-language-model-gate';
const npmGlobal = '/opt/homebrew/lib/node_modules/@zenithfoundry/slm-gate';
const npxCache = '/Users/someone/.npm/_npx/0123abcd/node_modules/@zenithfoundry/slm-gate';

describe('resolveHomeDir', () => {
  it('keeps a git checkout on its own folder, so clone installs are unchanged', () => {
    expect(resolveHomeDir({ installDir: clone, env: {}, userHome })).toBe(clone);
  });

  it.each([npmGlobal, npxCache])('moves an install inside node_modules (%s) to ~/.slm-gate, which upgrades do not replace', installDir => {
    expect(resolveHomeDir({ installDir, env: {}, userHome })).toBe(path.join(userHome, '.slm-gate'));
  });

  it.each([clone, npmGlobal])('uses SLM_GATE_HOME when it is set, whatever the install (%s)', installDir => {
    expect(resolveHomeDir({ installDir, env: { SLM_GATE_HOME: '/data/slm-gate' }, userHome })).toBe('/data/slm-gate');
  });

  it('treats a blank SLM_GATE_HOME as unset, like every other setting', () => {
    expect(resolveHomeDir({ installDir: npmGlobal, env: { SLM_GATE_HOME: '' }, userHome })).toBe(path.join(userHome, '.slm-gate'));
  });

  it('normalises SLM_GATE_HOME, e.g. a trailing slash', () => {
    expect(resolveHomeDir({ installDir: clone, env: { SLM_GATE_HOME: '/data/slm-gate/' }, userHome })).toBe('/data/slm-gate');
  });

  it.each(['slm-gate-home', './home', '~/.slm-gate'])('refuses a relative SLM_GATE_HOME (%s), which would change with the folder a tool starts in', value => {
    expect(() => resolveHomeDir({ installDir: clone, env: { SLM_GATE_HOME: value }, userHome })).toThrow(/SLM_GATE_HOME must be an absolute path/);
  });
});
