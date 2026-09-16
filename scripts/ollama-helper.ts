import { config } from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load environment variables from .env explicitly so scripts can run standalone
config();

// ESM polyfills for path resolution since __dirname and __filename are not available in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootPath = path.resolve(__dirname, '..');

/** The HTTP endpoint where the local Ollama instance is running. Defaults to standard local port. */
export const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

/** Maximum duration in milliseconds to wait for a model response before aborting the request. */
export const SLM_TIMEOUT_MS = process.env.SLM_TIMEOUT_MS || '60000';

/** The fast, primary small language model used for prompt conditioning, disambiguation, and routing. */
export const SLM_GATE_MODEL = process.env.SLM_GATE_MODEL || 'qwen2.5-coder:3b';

/** A slightly larger secondary local model used when more complex reasoning or verification is needed. */
export const SLM_BRAIN_MODEL = process.env.SLM_BRAIN_MODEL || 'qwen3.5:4b';

/** The model used specifically for offline testing and benchmarking suites. Defaults to matching SLM_GATE_MODEL. */
export const SLM_GATE_TESTING_MODEL = process.env.SLM_GATE_TESTING_MODEL || SLM_GATE_MODEL;

/** Duration for which models should remain loaded in VRAM after their last use to prevent cold-start delays. */
export const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '12h';

/**
 * Checks if the Ollama service is running and proactively warms up the specified models.
 * Warming up loads the models into memory/VRAM before actual tests or traffic begin,
 * which avoids timeouts caused by the initial cold-start standby delay.
 *
 * @param {string[]} [models] - List of model names to check and warm up. Defaults to the gate, brain, and testing models.
 * @param {number} [mountWaitMs=1000] - Additional buffer delay in ms after warmup requests finish, allowing the model to fully stabilize in VRAM.
 * @returns {Promise<boolean>} True if Ollama is reachable and models were warmed up successfully, false otherwise.
 */
export async function ensureOllamaReady(
  models: string[] = Array.from(new Set([SLM_GATE_MODEL, SLM_BRAIN_MODEL, SLM_GATE_TESTING_MODEL])),
  mountWaitMs = 1000
): Promise<boolean> {
  console.log(`[ollama-helper] Checking Ollama reachability at ${OLLAMA_HOST}...`);

  let availableModels: string[] = [];
  try {
    // Attempt to fetch the list of currently installed models to verify Ollama is online
    const res = await fetch(`${OLLAMA_HOST.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      console.warn(`[ollama-helper] Ollama responded with HTTP ${res.status}`);
      return false;
    }
    const data = await res.json() as { models?: Array<{ name: string; model?: string }> };
    // Extract just the model names/tags from the response payload
    availableModels = (data.models || []).map(m => m.name || m.model || '');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ollama-helper] Ollama is not reachable at ${OLLAMA_HOST}: ${msg}`);
    return false;
  }

  console.log(`[ollama-helper] Ollama is online. Available models: [${availableModels.join(', ')}]`);

  // Remove duplicate models to avoid redundant warmup requests
  const uniqueModels = Array.from(new Set(models));
  for (const model of uniqueModels) {
    // Check if the requested model is actually installed; handle cases with or without the tag
    const isPresent = availableModels.some(m => m === model || m.startsWith(`${model}:`));
    if (!isPresent) {
      console.warn(`[ollama-helper] Warning: Model '${model}' not found in Ollama tags.`);
      continue;
    }

    console.log(`[ollama-helper] Warming up model '${model}' (mounting to memory)...`);
    const startMount = Date.now();
    try {
      // Send a dummy generation request that predicts only 1 token.
      // This forces Ollama to load the model weights into memory without spending time generating text.
      await fetch(`${OLLAMA_HOST.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: 'warmup',
          stream: false,
          keep_alive: OLLAMA_KEEP_ALIVE, // Keep it in VRAM for future requests
          options: { num_predict: 1 }    // Minimize compute time for the warmup itself
        }),
        signal: AbortSignal.timeout(parseInt(SLM_TIMEOUT_MS, 10))
      });
      const mountElapsed = ((Date.now() - startMount) / 1000).toFixed(1);
      console.log(`[ollama-helper] Model '${model}' ready in ${mountElapsed}s.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ollama-helper] Warmup request for '${model}' failed: ${msg}`);
    }
  }

  // Optional buffer time to ensure models are truly ready to process subsequent heavy requests
  if (mountWaitMs > 0) {
    console.log(`[ollama-helper] Waiting ${mountWaitMs}ms for standby stabilization...`);
    await new Promise(resolve => setTimeout(resolve, mountWaitMs));
  }

  console.log(`[ollama-helper] Ollama preparation complete. Timeout set to ${SLM_TIMEOUT_MS}ms.`);
  return true;
}

/**
 * Ledger every spawned E2E gate writes to. A throwaway file per run, for the same reason
 * tests/setup-env.ts does it for the unit suite — except the motivation here is the CACHE the
 * ledger also holds: run against the developer's real ledger and a canned E2E payload is served
 * from a result computed by an EARLIER BUILD. A genuine regression then passes, and a genuine fix
 * appears to fail. Both happened while this was being verified.
 *
 * Exported because a test that asserts on ledger rows must open THIS database, not whatever
 * CONFIG.LEDGER_PATH resolved to in the parent process.
 *
 * Created on first use rather than at import: smoke-e2e's `--fake-downstream` child imports
 * this module too and would otherwise leave a second, empty directory behind on every run.
 * The directory is removed when the process that created it exits.
 */
let e2eLedgerDir: string | undefined;

export function e2eLedgerPath(): string {
  if (!e2eLedgerDir) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-e2e-'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    e2eLedgerDir = dir;
  }
  return path.join(e2eLedgerDir, 'e2e-ledger.sqlite');
}

/**
 * Constructs an environment variable map that inherits the current process environment
 * and injects necessary Ollama configuration constants. This is useful when spawning
 * child processes (like E2E tests) that need to know how to connect to the local SLM infrastructure.
 *
 * @param {Record<string, string>} [overrides] - Additional environment variables to set or override.
 * @returns {Record<string, string>} A complete dictionary of environment variables ready for a child process.
 */
export function getE2EEnv(overrides: Record<string, string> = {}): Record<string, string> {
  // Start with a clean copy of the current process environment, filtering out undefined values
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) {
      baseEnv[k] = v;
    }
  }

  return {
    ...baseEnv,
    OLLAMA_HOST,
    OLLAMA_KEEP_ALIVE,
    SLM_TIMEOUT_MS,
    SLM_GATE_MODEL,
    SLM_BRAIN_MODEL,
    SELF_CONSISTENCY_K: '1', // Default setting for generation passes
    LEDGER_PATH: e2eLedgerPath(),
    // Distillation thresholds are deliberately NOT pinned here. A script whose canned payload
    // is sized against particular DISTILL_MIN/MAX_TOKENS values passes them in `overrides`,
    // next to the payload, where the coupling is visible.
    ...overrides
  };
}
