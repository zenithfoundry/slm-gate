import { afterAll, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The OS boot-ID read is replaced so a failed or empty read can be simulated (macOS path: sysctl).
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-stop-marker-'));
const execFileSync = jest.fn<(...args: unknown[]) => string>();
jest.unstable_mockModule('node:child_process', () => ({ execFileSync, spawn: jest.fn() }));
jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: { OUTPUT_DIR: outputDir, ROOT_DIR: process.cwd(), MODEL_GATE_PORT: 1 },
  CONFIG_ENV_KEYS: [],
}));

const { isStoppedByUser } = await import('../../src/setup/model-gate.js');
const marker = path.join(outputDir, '.gate-stopped');

afterAll(() => fs.rmSync(outputDir, { recursive: true, force: true }));

(process.platform === 'darwin' ? describe : describe.skip)('a stop keyed to the boot ID, when the ID cannot be read', () => {
  // One scenario in order: the boot ID is remembered for the process once read, so the steps share that state.
  it('keeps the stop while the ID cannot be read, retries, ends it for a new boot, then remembers the ID', () => {
    fs.writeFileSync(marker, 'BOOT-1');

    execFileSync.mockImplementation(() => { throw new Error('sysctl timed out'); });
    expect(isStoppedByUser()).toBe(true);

    execFileSync.mockReturnValue('   \n'); // an empty answer counts as unreadable too
    expect(isStoppedByUser()).toBe(true);

    execFileSync.mockReturnValue('BOOT-2\n');
    expect(isStoppedByUser()).toBe(false);

    execFileSync.mockClear();
    fs.writeFileSync(marker, 'BOOT-2');
    expect(isStoppedByUser()).toBe(true);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
