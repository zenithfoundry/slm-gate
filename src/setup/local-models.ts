/**
 * @fileoverview Are the local models slm-gate is configured to use actually there? Used by `slm-gate doctor`
 * and by the MCP server's start-up check. It only reports, each problem with its exact fix; it never starts
 * Ollama or downloads a model.
 */
import { CONFIG } from '../config.js';

export interface SetupProblem {
  message: string;
  fix: string;
}

export interface ModelUse {
  name: string;
  setting: string;
  purpose: string;
}

/** The models this process's settings use, and what each one is for. */
export function requiredModels(): ModelUse[] {
  const models = [
    { name: CONFIG.SLM_GATE_MODEL, setting: 'SLM_GATE_MODEL', purpose: 'sorting requests and shrinking tool output' },
    { name: CONFIG.SLM_BRAIN_MODEL, setting: 'SLM_BRAIN_MODEL', purpose: 'answering first messages locally' },
  ];
  if (CONFIG.SEMCACHE || CONFIG.DISTILL_ADAPTIVE) {
    models.push({ name: CONFIG.EMBED_MODEL, setting: 'EMBED_MODEL', purpose: 'the semantic cache' });
  }
  return models;
}

/** Ollama lists `name:tag`; a setting without a tag means `:latest`. */
function isPulled(name: string, pulled: string[]): boolean {
  return pulled.includes(name) || (!name.includes(':') && pulled.includes(`${name}:latest`));
}

/**
 * @param params.timeoutMs How long to wait for Ollama (default 3000)
 * @param params.gateModels The models the running model gate uses (from its health answer). The gate reads
 *   only slm-gate's .env, which can name other models than the MCP env block this process was started with.
 *   A process whose own SLM_PROVIDER is not ollama checks nothing (its OLLAMA_HOST then points elsewhere);
 *   sessions on Ollama and `slm-gate doctor`, which reads the same .env as the gate, still check them.
 * @returns The problems found (empty when all is well) and the models Ollama has
 */
export async function checkLocalModels(params: { timeoutMs?: number; gateModels?: readonly ModelUse[] } = {}): Promise<{ problems: SetupProblem[]; pulled: string[] }> {
  if (CONFIG.SLM_PROVIDER !== 'ollama') return { problems: [], pulled: [] };

  let pulled: string[];
  try {
    const res = await fetch(`${CONFIG.OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(params.timeoutMs ?? 3000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json() as { models?: { name: string }[] };
    pulled = (data.models ?? []).map(model => model.name);
  } catch {
    return {
      problems: [{
        message: `Ollama is not running at ${CONFIG.OLLAMA_HOST}, so nothing is answered or shrunk locally (requests still reach the cloud).`,
        fix: 'Open the Ollama app, or run `ollama serve`.',
      }],
      pulled: [],
    };
  }

  const gateModels = (params.gateModels ?? []).map(model => ({ ...model, setting: `${model.setting} in slm-gate's .env` }));
  const problems = [...requiredModels(), ...gateModels]
    .filter((model, index, all) => all.findIndex(other => other.name === model.name) === index) // two settings, one model
    .filter(model => !isPulled(model.name, pulled))
    .map(model => ({
      message: `The local model ${model.name} (${model.setting}, used for ${model.purpose}) is not downloaded.`,
      fix: `ollama pull ${model.name}`,
    }));
  return { problems, pulled };
}
