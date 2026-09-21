import { describe, expect, it, jest } from '@jest/globals';
import { exitWithParent, findStrandedServers } from '../../src/setup/parent-watch.js';

/** Waits for something to become true, rather than for a number of milliseconds. */
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  await new Promise(resolve => setTimeout(resolve, 10));
}

/** Waits for the watch to have looked at least `times`, rather than for a number of milliseconds. */
const afterChecks = (ppid: { mock: { calls: unknown[] } }, times: number) => until(() => ppid.mock.calls.length >= times);

describe('exitWithParent', () => {
  it('shuts down once the process that started this one has gone', async () => {
    const onGone = jest.fn();
    const ppid = jest.fn(() => 500);
    const stop = exitWithParent({ everyMs: 5, ppid, onGone });
    await afterChecks(ppid, 2);
    expect(onGone).not.toHaveBeenCalled(); // parent still there: stay running

    ppid.mockReturnValue(1); // the coding tool exited and we were handed to init
    await until(() => onGone.mock.calls.length > 0);
    stop();
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('asks to shut down only once, however long it takes to happen', async () => {
    const onGone = jest.fn();
    const ppid = jest.fn(() => 500);
    exitWithParent({ everyMs: 5, ppid, onGone });
    ppid.mockReturnValue(1);
    await until(() => onGone.mock.calls.length > 0);
    await new Promise(resolve => setTimeout(resolve, 40)); // several more intervals' worth of chances
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('notices any change of parent, not only being handed to init', async () => {
    const onGone = jest.fn();
    const ppid = jest.fn(() => 500);
    exitWithParent({ everyMs: 5, ppid, onGone });
    ppid.mockReturnValue(742);
    await until(() => onGone.mock.calls.length > 0);
    expect(onGone).toHaveBeenCalled();
  });

  it('leaves a process started by a service manager alone, since it has no parent to lose', async () => {
    const onGone = jest.fn();
    const ppid = jest.fn(() => 1);
    exitWithParent({ everyMs: 5, ppid, onGone });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(onGone).not.toHaveBeenCalled();
    expect(ppid).toHaveBeenCalledTimes(1); // asked once at the start, then never again
  });

  it('stops watching when told to', async () => {
    const onGone = jest.fn();
    const ppid = jest.fn(() => 500);
    const stop = exitWithParent({ everyMs: 5, ppid, onGone });
    await afterChecks(ppid, 2);
    stop();
    const seen = ppid.mock.calls.length;
    ppid.mockReturnValue(1);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(ppid.mock.calls.length).toBe(seen);
    expect(onGone).not.toHaveBeenCalled();
  });
});

describe('findStrandedServers', () => {
  /** A `ps -Ao pid=,ppid=,command=` table. */
  const table = [
    '  501     1 node /repo/dist/mcp-gate/index.js',          // stranded
    '  502  4000 node /repo/dist/mcp-gate/index.js',          // a coding tool still owns this one
    '  503     1 node /repo/dist/llm-gate/index.js',          // the model gate, which is meant to outlive tools
    '  504     1 /usr/bin/node /other/src/mcp-gate/index.ts', // a second checkout, still ours
    '  505     1 ollama serve',
    '  506     1 grep mcp-gate/index',                       // somebody looking for them, not one of them
    // A shell running a script whose text mentions the path. Seen for real: 28 of these were offered
    // up to be killed, because a command line is text and the path appeared in the middle of it.
    '  507     1 /bin/zsh -c eval \'cd /repo\\012node dist/mcp-gate/index.js < /dev/null\'',
    '  508     1 node --require /x/preflight.cjs /repo/src/mcp-gate/index.ts', // flags before the entry
  ].join('\n');

  it('does not mistake a search for these servers for one of them', () => {
    expect(findStrandedServers({ ps: () => table, self: 999 })).not.toContain(506);
  });

  it('does not mistake a shell whose script text mentions the path for a server', () => {
    expect(findStrandedServers({ ps: () => table, self: 999 })).not.toContain(507);
  });

  it('still finds a server started with flags before the entry point', () => {
    expect(findStrandedServers({ ps: () => table, self: 999 })).toContain(508);
  });

  it('finds servers that nothing owns any more, across checkouts and both source and build', () => {
    expect(findStrandedServers({ ps: () => table, self: 999 })).toEqual([501, 504, 508]);
  });

  it('leaves the model gate alone, since it is meant to outlive the tool that started it', () => {
    expect(findStrandedServers({ ps: () => table, self: 999 })).not.toContain(503);
  });

  it('never reports the process doing the asking', () => {
    expect(findStrandedServers({ ps: () => table, self: 501 })).toEqual([504, 508]);
  });

  it('reports nothing rather than failing when the process table cannot be read', () => {
    expect(findStrandedServers({ ps: () => { throw new Error('ps: not found'); } })).toEqual([]);
  });

  it('reports nothing when every server still has a coding tool', () => {
    expect(findStrandedServers({ ps: () => '  502  4000 node /repo/dist/mcp-gate/index.js', self: 999 })).toEqual([]);
  });
});
