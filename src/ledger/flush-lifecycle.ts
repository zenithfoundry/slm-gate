/**
 * @fileoverview Langfuse flush lifecycle, shared by every long-lived gate process.
 *
 * Replaces the previous bare 5-minute `setInterval`. That design meant a gate which
 * answered a few tool calls and exited inside one interval shipped nothing at all, and a
 * backlog drained at only 50 events per 5 minutes — which is why the dashboard appeared
 * empty and then jumped.
 */

import { LangfuseSink } from './index.js';

/** Backstop poll. Short enough that data is reviewable almost immediately. */
const INTERVAL_MS = 15_000;

/**
 * Wall-clock budget for the shutdown drain. MCP hosts send SIGTERM and then force-kill
 * after a short grace period, so an unbounded network drain would just be killed mid-flight.
 */
const SHUTDOWN_BUDGET_MS = 4_000;

/**
 * Installs startup drain, periodic backstop, and a bounded shutdown drain.
 *
 * @param layer Log prefix identifying the calling gate (e.g. 'mcp-gate', 'llm-gate').
 * @returns A `flushSoon` function callers may invoke after writing an event to ship it
 *   near-immediately, debounced so a burst of events still results in one request.
 */
export function installLangfuseFlushLifecycle(layer: string): () => void {
  const flush = (why: string, options?: { deadlineMs?: number }) =>
    LangfuseSink.flushQueue(options).catch(err =>
      console.error(`[${layer}] Langfuse flush error (${why}):`, err)
    );

  // Drain whatever a previous process left behind.
  void flush('startup');

  // unref() so this timer never keeps the process alive on its own.
  setInterval(() => { void flush('interval'); }, INTERVAL_MS).unref();

  let shuttingDown = false;
  const drainAndExit = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await flush(signal, { deadlineMs: SHUTDOWN_BUDGET_MS });
    process.exit(0);
  };
  process.once('SIGINT', () => void drainAndExit('SIGINT'));
  process.once('SIGTERM', () => void drainAndExit('SIGTERM'));

  let debounce: NodeJS.Timeout | null = null;
  return function flushSoon() {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      void flush('debounced');
    }, 2_000);
    debounce.unref();
  };
}
