/**
 * @fileoverview Stops this MCP server when the coding tool that started it goes away.
 *
 * A stdio MCP server is owned by the editor that spawned it, but nothing in the operating system
 * enforces that: when the editor is force-quit or crashes, the server it started keeps running, is
 * reparented to init, and stays up until the machine reboots. Those orphans are not idle — each one
 * goes on probing Ollama and showing desktop notifications, from whatever build it was started with,
 * so a fault fixed weeks ago can still pop up on screen.
 *
 * Closed input is the quick, ordinary signal, but it only arrives once something is reading stdin, so
 * it is no help if start-up hangs before the transport attaches. Losing our parent is the signal that
 * always arrives, whatever went wrong and whichever transport is in use.
 */

import { execFileSync } from 'node:child_process';

/** A process line from `ps`: pid, parent pid, then the command. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
/** Our MCP server's entry point as a whole argument, built or from source. */
const MCP_ENTRY = /mcp-gate[/\\]index\.[mc]?[jt]s$/;
/**
 * What a JavaScript process is started by. The command has to be one of these AND the entry has to be
 * one of its arguments, because a command line is text: a shell running a script that merely mentions
 * the path, or a `grep` for it, otherwise counts as a server and gets offered up to be killed.
 */
const RUNTIME = /(^|[/\\])(node|npm|npx|pnpm|yarn|tsx|bun|deno)$/;

/** True when this command line is a JavaScript runtime actually running our MCP server. */
function isOurServer(command: string): boolean {
  const [runtime, ...args] = command.trim().split(/\s+/);
  return RUNTIME.test(runtime) && args.some(arg => MCP_ENTRY.test(arg));
}

/**
 * slm-gate MCP servers still running with nothing to own them, for `slm-gate doctor` to name.
 *
 * Builds from before this file existed have no way to notice their coding tool has gone, so they stay
 * up until the machine reboots. Only reports them: which processes to end is the user's call, and a
 * server belonging to an editor this check cannot see would be the wrong thing to kill.
 *
 * @param params.ps Reads the process table; defaults to running `ps`
 * @param params.self This process, never reported; defaults to the real pid
 * @returns The pids, empty when there are none or the process table cannot be read
 */
export function findStrandedServers(params: { ps?: () => string; self?: number } = {}): number[] {
  const self = params.self ?? process.pid;
  let table: string;
  try {
    table = params.ps ? params.ps() : execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 2000 });
  } catch {
    return []; // no ps, or not allowed to run it: this is a convenience, never a failure
  }
  return table
    .split('\n')
    .map(line => PS_LINE.exec(line))
    .filter((parts): parts is RegExpExecArray => parts !== null)
    // Parent 1 means the process that started it is gone and init has taken it over.
    .filter(parts => parts[2] === '1' && Number(parts[1]) !== self && isOurServer(parts[3]))
    .map(parts => Number(parts[1]));
}

/**
 * Calls `onGone` when the process that started this one has exited.
 *
 * Reparenting is the test: every process keeps its parent until that parent dies, at which point the
 * operating system hands it to init. A process that already belongs to init was started by a service
 * manager and has no parent to lose, so it is left alone.
 *
 * @param params.everyMs How often to look (default 30 s; this is one syscall)
 * @param params.ppid Reads the current parent process id; defaults to the real one
 * @param params.onGone Defaults to asking ourselves to shut down the same way a `slm-gate stop` would
 * @returns Stops watching (tests, and shutdown paths that no longer need it)
 */
export function exitWithParent(params: {
  everyMs?: number;
  ppid?: () => number;
  onGone?: () => void;
} = {}): () => void {
  const readPpid = params.ppid ?? (() => process.ppid);
  const startedUnder = readPpid();
  if (startedUnder <= 1) return () => {}; // already owned by init: nothing to watch for

  const onGone = params.onGone ?? (() => process.kill(process.pid, 'SIGTERM'));
  const timer = setInterval(() => {
    if (readPpid() === startedUnder) return;
    clearInterval(timer);
    onGone();
  }, params.everyMs ?? 30_000);
  timer.unref(); // never keep the process alive just to watch for its parent
  return () => clearInterval(timer);
}
