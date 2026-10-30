/**
 * @fileoverview The shutdown sequence both daemons share: stop accepting, let in-flight work finish within a
 * bound, flush Langfuse, close the ledger, exit; and never exit before an in-flight request that finishes in time.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../src/ledger/db.js', () => ({ closeDb: jest.fn() }));

const { closeDb } = await import('../src/ledger/db.js');
const { beginRequest } = await import('../src/models/busy.js');
const { createShutdown } = await import('../src/shutdown.js');

const steps: string[] = [];
const sequence = (graceMs: number) => createShutdown({
  scope: 'test',
  graceMs,
  stopAccepting: () => { steps.push('stop'); },
  drainLangfuse: async () => { steps.push('drain'); },
  exit: code => { steps.push(`exit ${code}`); },
});

beforeEach(() => {
  steps.length = 0;
  (closeDb as jest.Mock).mockImplementation(() => { steps.push('closeDb'); });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('createShutdown', () => {
  it('stops accepting first, waits for a request that finishes in time, then drains, closes the ledger and exits 0', async () => {
    const done = beginRequest();
    setTimeout(() => { steps.push('request done'); done(); }, 50);
    await sequence(5_000)('SIGTERM');
    expect(steps).toEqual(['stop', 'request done', 'drain', 'closeDb', 'exit 0']);
  });

  it('exits anyway once the grace period is over, still draining and closing', async () => {
    const done = beginRequest();
    try {
      await sequence(50)('SIGINT');
      expect(steps).toEqual(['stop', 'drain', 'closeDb', 'exit 0']);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[test] in-flight work did not finish in time'));
    } finally {
      done();
    }
  });

  it('runs once: a second signal while the first is in progress is ignored', async () => {
    const shutdown = sequence(5_000);
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(steps.filter(step => step === 'exit 0')).toHaveLength(1);
  });

  it('still exits when a step throws', async () => {
    const shutdown = createShutdown({
      scope: 'test',
      graceMs: 50,
      stopAccepting: () => { throw new Error('socket already gone'); },
      drainLangfuse: async () => { steps.push('drain'); },
      exit: code => { steps.push(`exit ${code}`); },
    });
    await shutdown('SIGTERM');
    expect(steps).toEqual(['exit 0']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('shutdown step failed'));
  });
});
