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
 * @param promise - The asynchronous operation to wrap.
 * @param stage - The name of the pipeline stage (e.g. 'distill', 'classify') used in the error message.
 * @param timeoutMs - The maximum allowed time in milliseconds.
 * @returns A promise that resolves with the original result if completed in time.
 * 
 * @example
 * ```typescript
 * const result = await withSlmTimeout(slm.generateText(model, prompt), 'generate', 15000);
 * ```
 */
export async function withSlmTimeout<T>(promise: Promise<T>, stage: string, timeoutMs: number): Promise<T> {
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
 * @param err - The caught error object.
 * @param stage - The stage of the pipeline where the error occurred.
 * @param model - The name of the model being used.
 * 
 * @example
 * ```typescript
 * try {
 *   await slm.generateText(model, prompt);
 * } catch (err) {
 *   handleSlmError(err, 'pipeline:distill', model);
 * }
 * ```
 */
export function handleSlmError(err: any, stage: string, model: string) {
  const isTimeout = err instanceof SlmTimeoutError || err.name === 'SlmTimeoutError';
  const isNetwork = err.message?.includes('fetch failed') || err.message?.includes('ECONNREFUSED') || err.code === 'ECONNREFUSED';
  
  if (isTimeout || isNetwork) {
    const errorType = isTimeout ? 'Timeout' : 'Unreachable';
    console.error(`\n[${stage}] ❌ SLM Error (${errorType}) - Model: ${model}`);
    console.error(`  Usually the model is too large for available RAM or is cold-loading.`);
    console.error(`  Fixes:`);
    console.error(`  1. Switch to a smaller model (check SLM_BRAIN_MODEL/SLM_GATE_MODEL against the RAM table in docs/prerequisites-and-hardware.md).`);
    console.error(`  2. Raise SLM_TIMEOUT_MS in your .env if it is just cold-loading.`);
    console.error(`  3. Confirm the model is pulled ('ollama pull ${model}') and Ollama is running ('ollama list').`);
    console.error(`  4. Free up system RAM.\n`);
  } else {
    console.error(`\n[${stage}] ❌ SLM Error - Model: ${model}`);
    console.error(`  ${err.message || String(err)}\n`);
  }
}
