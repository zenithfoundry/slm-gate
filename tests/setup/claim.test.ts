import { afterAll, describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimWindow } from '../../src/setup/claim.js';
import { claimNotice } from '../../src/setup/notify.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-claim-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Runs claimWindow in a separate Node process at `startAt`, so several processes race for one marker. */
function claimInChild(params: { file: string; startAt: number }): Promise<string> {
  const claimModule = path.resolve('src/setup/claim.ts');
  const script = `
    import { claimWindow } from ${JSON.stringify(claimModule)};
    await new Promise(resolve => setTimeout(resolve, ${params.startAt} - Date.now()));
    process.stdout.write(String(claimWindow({ file: ${JSON.stringify(params.file)}, windowMs: 60000, now: ${params.startAt} })));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]);
    let out = '';
    child.stdout.on('data', chunk => out += chunk);
    child.on('error', reject);
    child.on('exit', () => resolve(out.trim()));
  });
}

describe('claimWindow', () => {
  it('lets the first caller in each window through and refuses the rest', () => {
    const file = path.join(dir, 'single');
    expect(claimWindow({ file, windowMs: 1000, now: 10_000 })).toBe(true);
    expect(claimWindow({ file, windowMs: 1000, now: 10_500 })).toBe(false);
    expect(claimWindow({ file, windowMs: 1000, now: 11_000 })).toBe(true);
    expect(claimWindow({ file, windowMs: 1000, now: 11_999 })).toBe(false);
  });

  it('lets exactly one of several processes through when they claim at the same moment', async () => {
    const file = path.join(dir, 'race');
    const startAt = Date.now() + 3000;
    const results = await Promise.all(Array.from({ length: 6 }, () => claimInChild({ file, startAt })));
    expect(results.filter(result => result === 'true')).toHaveLength(1);
    expect(results.filter(result => result === 'false')).toHaveLength(5);
  }, 30_000);

  it('keeps no more than the last two windows\' markers on disk', () => {
    const file = path.join(dir, 'cleanup');
    for (let window = 0; window < 5; window++) claimWindow({ file, windowMs: 1000, now: window * 1000 });
    expect(fs.readdirSync(dir).filter(name => name.startsWith('cleanup.')).sort()).toEqual(['cleanup.3', 'cleanup.4']);
  });
});

describe('claimNotice', () => {
  it('shows each problem at most once per 10 minutes, and different problems independently', () => {
    const notices = path.join(dir, 'notices');
    expect(claimNotice({ key: 'port-taken', dir: notices, now: 0 })).toBe(true);
    expect(claimNotice({ key: 'port-taken', dir: notices, now: 9 * 60_000 })).toBe(false);
    expect(claimNotice({ key: 'gate-stale', dir: notices, now: 9 * 60_000 })).toBe(true);
    expect(claimNotice({ key: 'port-taken', dir: notices, now: 10 * 60_000 })).toBe(true);
  });
});
