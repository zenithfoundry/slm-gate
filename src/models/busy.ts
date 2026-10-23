/**
 * @fileoverview Is this process busy? Two counters: requests the model gate is handling, and local-model calls
 * it has running. Background work that must never slow a request (the conversation memory fold) waits for
 * both to be zero. Only this process is counted: the MCP gate is a separate process with its own calls, and
 * Ollama queues those per model, so an overlap there costs a short wait, never a wrong result.
 */

let requestsInFlight = 0;
let modelCallsRunning = 0;
let waiters: (() => void)[] = [];

function settleIfIdle(): void {
  if (requestsInFlight > 0 || modelCallsRunning > 0) return;
  const toWake = waiters;
  waiters = [];
  for (const wake of toWake) wake();
}

/** Marks a request as being handled until the returned function is called. */
export function beginRequest(): () => void {
  requestsInFlight++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    requestsInFlight--;
    settleIfIdle();
  };
}

/** Counts a local-model call for as long as its promise is pending. */
export function track<T>(call: Promise<T>): Promise<T> {
  modelCallsRunning++;
  return call.finally(() => {
    modelCallsRunning--;
    settleIfIdle();
  });
}

/** Resolves as soon as no request is being handled and no local-model call is running. */
export function whenIdle(): Promise<void> {
  if (requestsInFlight === 0 && modelCallsRunning === 0) return Promise.resolve();
  return new Promise(resolve => { waiters.push(resolve); });
}

/** For tests and `slm-gate memory`. */
export function busyCounts(): { requestsInFlight: number; modelCallsRunning: number } {
  return { requestsInFlight, modelCallsRunning };
}
