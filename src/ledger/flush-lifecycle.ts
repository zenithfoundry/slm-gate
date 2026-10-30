/**
 * @fileoverview Langfuse flush lifecycle, shared by every long-lived gate process.
 *
 * Replaces the previous bare 5-minute `setInterval`. That design meant a gate which
 * answered a few tool calls and exited inside one interval shipped nothing at all, and a
 * backlog drained at only 50 events per 5 minutes — which is why the dashboard appeared
 * empty and then jumped.
 */

import { log } from '../log.js';
import { LangfuseSink } from './index.js';

/** Backstop poll. Short enough that data is reviewable almost immediately. */
const INTERVAL_MS = 15_000;

/**
 * Wall-clock budget for the shutdown drain. MCP hosts send SIGTERM and then force-kill
 * after a short grace period, so an unbounded network drain would just be killed mid-flight.
 */
const SHUTDOWN_BUDGET_MS = 4_000;

/**
 * Installs the startup drain and the periodic backstop. The shutdown drain is a step of the process's
 * shutdown sequence (src/shutdown.ts), which runs it once in-flight work has finished.
 *
 * @param layer Log scope identifying the calling gate (e.g. 'mcp-gate', 'llm-gate').
 * @returns `flushSoon`, which callers may invoke after writing an event to ship it near-immediately
 *   (debounced, so a burst of events still results in one request), and `drainForShutdown`.
 */
export function installLangfuseFlushLifecycle(layer: string): { flushSoon: () => void; drainForShutdown: () => Promise<void> } {
  const flush = (why: string, options?: { deadlineMs?: number }) =>
    LangfuseSink.flushQueue(options).then(() => undefined, err =>
      log.error(layer, `Langfuse flush error (${why})`, { error: err })
    );

  // Drain whatever a previous process left behind.
  void flush('startup');

  // unref() so this timer never keeps the process alive on its own.
  setInterval(() => { void flush('interval'); }, INTERVAL_MS).unref();

  let debounce: NodeJS.Timeout | null = null;
  return {
    flushSoon() {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        void flush('debounced');
      }, 2_000);
      debounce.unref();
    },
    drainForShutdown: () => flush('shutdown', { deadlineMs: SHUTDOWN_BUDGET_MS }),
  };
}
