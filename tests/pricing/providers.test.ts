/**
 * @fileoverview The provider registry override file (PROVIDER_REGISTRY_PATH) is checked for shape before
 * anything is merged: a wrong file leaves the built-in registry whole and says why.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __resetProviderRegistry, DEFAULT_PROVIDER_REGISTRY, getProviderRegistry } from '../../src/pricing/providers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-providers-'));
const file = (name: string, content: unknown) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
};

beforeEach(() => {
  __resetProviderRegistry();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  __resetProviderRegistry();
  jest.restoreAllMocks();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('PROVIDER_REGISTRY_PATH', () => {
  it('merges a well-formed override over the built-in profile and accepts a new provider id', () => {
    const registry = getProviderRegistry(file('good.json', {
      claude: { windowMinutes: 420, modelPatterns: ['claude', 'fable'] },
      acme: { metering: 'message', agentPatterns: ['acme-ide'] },
    }));
    expect(registry.claude).toMatchObject({ windowMinutes: 420, metering: 'compute', modelPatterns: ['claude', 'fable'] });
    expect(registry.acme).toMatchObject({ metering: 'message', agentPatterns: ['acme-ide'], windowMinutes: DEFAULT_PROVIDER_REGISTRY.claude.windowMinutes });
  });

  it('keeps the defaults and names the first problem when the file has the wrong shape', () => {
    const registry = getProviderRegistry(file('bad.json', { claude: { windowMinutes: 'five hours' } }));
    expect(registry.claude.windowMinutes).toBe(DEFAULT_PROVIDER_REGISTRY.claude.windowMinutes);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/\[providers\] Could not use PROVIDER_REGISTRY_PATH .*claude\.windowMinutes: Expected number/));
  });

  it('keeps the defaults when the file is not an object of profiles', () => {
    const registry = getProviderRegistry(file('list.json', ['claude']));
    expect(registry).toMatchObject(DEFAULT_PROVIDER_REGISTRY);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[providers] Could not use PROVIDER_REGISTRY_PATH'));
  });
});
