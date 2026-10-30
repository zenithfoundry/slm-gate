/**
 * @fileoverview The one retry policy for calls to Langfuse: exponential backoff with jitter, honouring
 * Retry-After, and the request spacing that keeps a hobby project under its rate limit. Shared by the
 * ledger's flush, the sync, verify and wipe scripts and the dashboard setup.
 */

import { log } from '../log.js';

/** Langfuse hobby projects allow 30 requests a minute; one request every 2.1 s stays under it. */
export const LANGFUSE_REQUEST_SPACING_MS = 2100;

/** No single Langfuse request waits longer than this for its answer (`AbortSignal.timeout`). */
export const LANGFUSE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Calculates exponential backoff with jitter and awaits the delay period.
 *
 * @desc Computes 1500ms * 2^attempt + jitter, respecting an optional `Retry-After` header value in seconds.
 * Logs a diagnostic warning to stderr before waiting.
 * @param params.attempt Current zero-indexed retry attempt
 * @param params.maxRetries Total allowed retry attempts
 * @param params.reason Human-readable context for why the backoff is being executed
 * @param params.retryAfter Optional `Retry-After` header string from HTTP response
 * @param params.layer Log prefix identifying the calling layer (e.g. 'llm-gate', 'ledger')
 * @returns Promise that resolves once the backoff delay has completed
 * @example
 * ```ts
 * await waitWithBackoff({ attempt, maxRetries: MAX_RETRIES, reason: 'Upstream HTTP 429', retryAfter: res.headers.get('retry-after') });
 * ```
 */
export async function waitWithBackoff(params: {
  attempt: number;
  maxRetries: number;
  reason: string;
  retryAfter?: string | null;
  layer?: string;
}): Promise<void> {
  const { attempt, maxRetries, reason, retryAfter, layer = 'llm-gate' } = params;
  await new Promise<void>((resolve) =>
    setTimeout(resolve, computeBackoffMs({ attempt, reason, retryAfter, maxRetries, layer }))
  );
}

/**
 * Pure delay calculation, split out so it can be unit-tested without waiting in real time.
 *
 * @param params.attempt Current zero-indexed retry attempt
 * @param params.reason Human-readable context, used only for the log line
 * @param params.retryAfter Optional `Retry-After` header string, in seconds
 * @param params.maxRetries Total allowed retry attempts, used only for the log line
 * @param params.layer Log prefix identifying the calling layer
 * @returns Delay in milliseconds
 */
export function computeBackoffMs(params: {
  attempt: number;
  reason: string;
  retryAfter?: string | null;
  maxRetries?: number;
  layer?: string;
}): number {
  const { attempt, reason, retryAfter, maxRetries = 0, layer = 'llm-gate' } = params;
  let delayMs = 1500 * Math.pow(2, attempt) + Math.random() * 500;
  if (retryAfter) {
    const parsedSeconds = parseInt(retryAfter, 10);
    if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
      delayMs = Math.max(delayMs, parsedSeconds * 1000);
    }
  }
  log.warn(layer, `${reason}. Retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${maxRetries})...`);
  return delayMs;
}
