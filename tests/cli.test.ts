import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const version = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
const cli = (...args: string[]) =>
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8' });

describe('slm-gate --version', () => {
  it.each(['--version', '-v', 'version'])('prints the installed version, and nothing else, for %s', flag => {
    expect(cli(flag).trim()).toBe(version);
  });
});
