/**
 * @fileoverview Shared exponential-backoff helper.
 *
 * Extracted from llm-gate/pipeline.ts so the ledger's Langfuse flush can reuse the same
 * retry policy. It cannot simply import from the pipeline: llm-gate/pipeline.ts imports
 * the ledger, so that direction would be circular.
 */

/**
 * Calculates exponential backoff with jitter and awaits the delay period.
 *
 * @desc Computes 1500ms * 2^attempt + jitter, respecting an optional `Retry-After` header value in seconds.
 * Logs a diagnostic warning to stderr before waiting.
 * @param attempt Current zero-indexed retry attempt
 * @param maxRetries Total allowed retry attempts
 * @param reason Human-readable context for why the backoff is being executed
 * @param retryAfter Optional `Retry-After` header string from HTTP response
 * @param layer Log prefix identifying the calling layer (e.g. 'llm-gate', 'ledger')
 * @returns Promise that resolves once the backoff delay has completed
 * @example
 * ```ts
 * await waitWithBackoff(attempt, MAX_RETRIES, 'Upstream HTTP 429', res.headers.get('retry-after'));
 * ```
 */
export async function waitWithBackoff(
  attempt: number,
  maxRetries: number,
  reason: string,
  retryAfter?: string | null,
  layer = 'llm-gate'
): Promise<void> {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, computeBackoffMs(attempt, reason, retryAfter, maxRetries, layer))
  );
}

/**
 * Pure delay calculation, split out so it can be unit-tested without waiting in real time.
 *
 * @param attempt Current zero-indexed retry attempt
 * @param reason Human-readable context, used only for the log line
 * @param retryAfter Optional `Retry-After` header string, in seconds
 * @param maxRetries Total allowed retry attempts, used only for the log line
 * @param layer Log prefix identifying the calling layer
 * @returns Delay in milliseconds
 */
export function computeBackoffMs(
  attempt: number,
  reason: string,
  retryAfter?: string | null,
  maxRetries = 0,
  layer = 'llm-gate'
): number {
  let delayMs = 1500 * Math.pow(2, attempt) + Math.random() * 500;
  if (retryAfter) {
    const parsedSeconds = parseInt(retryAfter, 10);
    if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
      delayMs = Math.max(delayMs, parsedSeconds * 1000);
    }
  }
  console.error(`[${layer}] ${reason}. Retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${maxRetries})...`);
  return delayMs;
}
