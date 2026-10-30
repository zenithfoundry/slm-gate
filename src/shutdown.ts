/**
 * The orderly stop both daemons share. On SIGTERM or SIGINT: stop taking new work, give what is in flight a
 * bounded time to finish (a model reply streams to its end, a tool call completes), ship the Langfuse queue
 * within its own budget, close the ledger, exit. A second signal is ignored: the first is in charge.
 */
import { closeDb } from './ledger/db.js';
import { log } from './log.js';
import { whenIdle } from './models/busy.js';

/** How long in-flight work may take to finish before the process exits anyway. */
const IN_FLIGHT_GRACE_MS = 10_000;

export interface ShutdownSteps {
  /** Log scope, e.g. 'llm-gate'. */
  scope: string;
  /** Refuse new work: close the listening sockets; nothing for a stdio server, whose input is already closed. */
  stopAccepting: () => void | Promise<void>;
  /** Ship the Langfuse queue, bounded by its own deadline (src/ledger/flush-lifecycle.ts). */
  drainLangfuse: () => Promise<void>;
  /** Tests: a shorter grace and no real exit. */
  graceMs?: number;
  exit?: (code: number) => void;
}

/** The shutdown sequence as one function; `installShutdown` wires it to the signals. */
export function createShutdown(steps: ShutdownSteps): (signal: string) => Promise<void> {
  const grace = steps.graceMs ?? IN_FLIGHT_GRACE_MS;
  const exit = steps.exit ?? ((code: number) => process.exit(code));
  let started = false;
  return async (signal: string) => {
    if (started) return;
    started = true;
    log.info(steps.scope, 'shutting down', { signal });
    try {
      await steps.stopAccepting();
      const finished = await Promise.race([
        whenIdle().then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), grace).unref()),
      ]);
      if (!finished) log.warn(steps.scope, 'in-flight work did not finish in time; exiting anyway', { grace_ms: grace });
      await steps.drainLangfuse();
      closeDb();
    } catch (err) {
      log.error(steps.scope, 'shutdown step failed', { error: err });
    }
    exit(0);
  };
}

/** Runs the sequence on SIGINT and SIGTERM. */
export function installShutdown(steps: ShutdownSteps): void {
  const shutdown = createShutdown(steps);
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
