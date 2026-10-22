/**
 * @fileoverview Keeps slm-gate's two local models loaded ("pinned").
 *
 * slm-gate works with a pair of models on every request, the brain and the gate; the machine's RAM decides
 * their size and context (RAM_PRESET), not their number. Ollama's slot count (OLLAMA_MAX_LOADED_MODELS) is
 * therefore 2, exactly the pair. Every call slm-gate makes carries a long keep-alive, so its models never
 * time out on their own. What does evict them is a THIRD model being loaded by something else: `ollama run
 * some-other-model`, a benchmark trying a different gate model, another app. With three models and two
 * slots, one is always being unloaded and the next call pays the reload — the "models keep unmounting" symptom.
 *
 * `pinModels` puts that right: when one of the gate's models is missing AND a model it does not use is
 * loaded, it asks Ollama to unload the stranger (a request with keep-alive 0) and warms the missing model
 * back in. It touches nothing while both models are resident, and it never unloads anything unless one of its
 * own models was displaced. The model gate runs it at start and every minute; the benchmark runs it when it
 * finishes. `SLM_PIN_MODELS=off` turns it off.
 */
import { Ollama } from 'ollama';
import { CONFIG } from '../config.js';
import { requiredModels } from '../setup/local-models.js';

/** How often the running model gate checks. A reload costs seconds, so a minute's lag is acceptable. */
export const PIN_INTERVAL_MS = 60_000;

export interface PinResult {
  /** Models the gate uses that were loaded when checked. */
  resident: string[];
  /** Models the gate uses that were missing and have been warmed back in. */
  warmed: string[];
  /** Loaded models the gate does not use that were unloaded to make room. */
  unloaded: string[];
  /** Ollama could not be reached, or the check was turned off. */
  skipped: string | null;
}

/** Ollama lists `name:tag`; a setting without a tag means `:latest`. */
function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`);
  return norm(a) === norm(b);
}

/**
 * One check-and-repair pass. Safe to call often: the common case (both models resident) is a single
 * list call and no change.
 */
export async function pinModels(client: Ollama = new Ollama({ host: CONFIG.OLLAMA_HOST })): Promise<PinResult> {
  const result: PinResult = { resident: [], warmed: [], unloaded: [], skipped: null };
  if (!CONFIG.SLM_PIN_MODELS) return { ...result, skipped: 'SLM_PIN_MODELS=off' };

  const wanted = [...new Set(requiredModels().map(m => m.name))];
  let loaded: string[];
  try {
    loaded = (await client.ps()).models.map(m => m.name);
  } catch (err) {
    return { ...result, skipped: `Ollama not reachable: ${err instanceof Error ? err.message : String(err)}` };
  }

  result.resident = wanted.filter(w => loaded.some(l => sameModel(l, w)));
  const missing = wanted.filter(w => !result.resident.includes(w));
  if (missing.length === 0) return result;

  // Only when one of ours was displaced: free the slots strangers hold, then bring ours back.
  const strangers = loaded.filter(l => !wanted.some(w => sameModel(l, w)));
  for (const name of strangers) {
    try {
      await client.generate({ model: name, prompt: '', keep_alive: 0 });
      result.unloaded.push(name);
    } catch {
      // A model that refuses to unload is left alone; the warm-up below may still fit beside it.
    }
  }
  // Ollama frees the slot a moment after answering. Warming before it has would evict a model we just
  // warmed, so wait (briefly) until no unloaded model is still listed.
  if (result.unloaded.length > 0) await untilGone(client, result.unloaded);
  for (const name of missing) {
    try {
      await client.generate({ model: name, prompt: 'ok', keep_alive: CONFIG.OLLAMA_KEEP_ALIVE, options: { num_ctx: CONFIG.NUM_CTX, num_predict: 1 } });
      result.warmed.push(name);
    } catch {
      // Not pulled, or Ollama busy: the next real call reports that on its own.
    }
  }
  return result;
}

/** Polls `ps` until none of the named models is listed, or the wait runs out (then warming proceeds anyway). */
async function untilGone(client: Ollama, names: string[], waitMs = 5000, stepMs = 250): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const loaded = (await client.ps()).models.map(m => m.name);
      if (!names.some(n => loaded.some(l => sameModel(l, n)))) return;
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

/** Logs a pass that changed something; silent otherwise. */
export function describePin(result: PinResult): string | null {
  if (result.skipped) return null;
  if (result.unloaded.length === 0 && result.warmed.length === 0) return null;
  const parts: string[] = [];
  if (result.unloaded.length) parts.push(`unloaded ${result.unloaded.join(', ')} (not one of slm-gate's models; it had displaced one)`);
  if (result.warmed.length) parts.push(`warmed ${result.warmed.join(', ')} back in`);
  return `[models] ${parts.join('; ')}`;
}

/**
 * Starts the periodic check in a long-running process. The timer never keeps the process alive on its own.
 * Returns a stop function.
 */
export function startPinningModels(): () => void {
  const run = async () => {
    const line = describePin(await pinModels());
    if (line) console.error(line);
  };
  void run();
  const timer = setInterval(() => { void run(); }, PIN_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
