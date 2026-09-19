import { afterAll, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A folder with a space: the install path that used to stop the model gate from ever listening.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm gate test '));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const helper = JSON.stringify(path.resolve('src/utils/entry-point.ts'));
fs.writeFileSync(path.join(dir, 'main.ts'), `
  import { isEntryPoint } from ${helper};
  import { importedIsEntry } from './lib.ts';
  process.stdout.write(JSON.stringify({ main: isEntryPoint(import.meta.url), lib: importedIsEntry }));
`);
fs.writeFileSync(path.join(dir, 'lib.ts'), `
  import { isEntryPoint } from ${helper};
  export const importedIsEntry = isEntryPoint(import.meta.url);
`);
fs.symlinkSync(path.join(dir, 'main.ts'), path.join(dir, 'linked main.ts'));

function run(script: string): { main: boolean; lib: boolean } {
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', path.join(dir, script)], { encoding: 'utf8' }));
}

describe('isEntryPoint', () => {
  it('recognises the started script in a folder whose path has a space, and not a module it imports', () => {
    expect(run('main.ts')).toEqual({ main: true, lib: false });
  });

  it('recognises the started script when it is launched through a symlink', () => {
    expect(run('linked main.ts')).toEqual({ main: true, lib: false });
  });
});
