/**
 * The failure vocabulary of a local model call: the format and timeout error classes, the timeout wrapper
 * every call runs under, and the one place a failure is turned into an actionable message. Kept apart from
 * slm.ts so the resolver and pipeline can name the errors without pulling in the client.
 */
import { log } from '../log.js';

/**
 * Represents an error that occurs when the SLM returns a response that cannot be parsed
 * or formatted correctly (e.g. invalid JSON when JSON is expected).
 * 
 * @example
 * ```typescript
 * throw new SlmFormatError("Invalid JSON returned by the model");
 * ```
 */
export class SlmFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlmFormatError';
  }
}

/**
 * Represents an error that occurs when a call to the SLM exceeds the configured timeout duration.
 * 
 * @example
 * ```typescript
 * throw new SlmTimeoutError("classification");
 * ```
 */
export class SlmTimeoutError extends Error {
  constructor(stage: string) {
    super(`SLM call timed out during stage: ${stage}`);
    this.name = 'SlmTimeoutError';
  }
}

/**
 * Wraps a promise (usually an SLM generation call) with a timeout. If the promise does not 
 * resolve within `timeoutMs`, an `SlmTimeoutError` is thrown.
 * 
 * @param params.promise - The asynchronous operation to wrap.
 * @param params.stage - The name of the pipeline stage (e.g. 'distill', 'classify') used in the error message.
 * @param params.timeoutMs - The maximum allowed time in milliseconds.
 * @returns A promise that resolves with the original result if completed in time.
 * 
 * @example
 * ```typescript
 * const result = await withSlmTimeout({ promise: slm.generateText({ model, messages }), stage: 'generate', timeoutMs: 15000 });
 * ```
 */
export async function withSlmTimeout<T>(params: { promise: Promise<T>; stage: string; timeoutMs: number }): Promise<T> {
  const { promise, stage, timeoutMs } = params;
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SlmTimeoutError(stage)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * A centralized error handler for formatting and logging SLM failures.
 * Handles timeouts and network connection issues by printing actionable remediation
 * steps to the console, while falling back to standard error logging for other issues.
 * 
 * @param params.err - The caught error object.
 * @param params.stage - The stage of the pipeline where the error occurred.
 * @param params.model - The name of the model being used.
 * 
 * @example
 * ```typescript
 * try {
 *   await slm.generateText(model, prompt);
 * } catch (err) {
 *   handleSlmError({ err, stage: 'pipeline:distill', model });
 * }
 * ```
 */
export function handleSlmError(params: { err: any; stage: string; model: string }) {
  const { err, stage, model } = params;
  const isTimeout = err instanceof SlmTimeoutError || err.name === 'SlmTimeoutError';
  const isNetwork = err.message?.includes('fetch failed') || err.message?.includes('ECONNREFUSED') || err.code === 'ECONNREFUSED';
  
  if (isTimeout || isNetwork) {
    const errorType = isTimeout ? 'timeout' : 'unreachable';
    log.error(stage, `SLM error (${errorType}): usually the model is too large for the available RAM or is cold-loading`, {
      model,
      fix: `switch to a smaller model (check SLM_BRAIN_MODEL/SLM_GATE_MODEL against the RAM table in docs/reference/hardware.md); raise SLM_TIMEOUT_MS in .env if it is just cold-loading; confirm it is pulled ('ollama pull ${model}') and Ollama is running ('ollama list'); or free up RAM`,
    });
  } else {
    log.error(stage, 'SLM error', { model, error: err.message || String(err) });
  }
}
