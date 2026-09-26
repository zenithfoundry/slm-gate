/**
 * @fileoverview Which local models a set of settings needs, and what each one is for. One rule for the
 * start-up check (the running settings, src/setup/local-models.ts) and `slm-gate init` (the settings file
 * it writes, src/setup/init.ts). No side effects, so init can use it without loading the configuration.
 */

export interface ModelUse {
  name: string;
  setting: string;
  purpose: string;
}

/**
 * @param settings The model settings, and the two features that use the embedding model
 * @returns The models to have in Ollama: both SLM models, plus EMBED_MODEL when either feature is on
 */
export function modelsFor(settings: {
  SLM_GATE_MODEL: string;
  SLM_BRAIN_MODEL: string;
  EMBED_MODEL: string;
  SEMCACHE: boolean;
  DISTILL_ADAPTIVE: boolean;
}): ModelUse[] {
  const models = [
    { name: settings.SLM_GATE_MODEL, setting: 'SLM_GATE_MODEL', purpose: 'sorting requests and shrinking tool output' },
    { name: settings.SLM_BRAIN_MODEL, setting: 'SLM_BRAIN_MODEL', purpose: 'answering first messages locally' },
  ];
  if (settings.SEMCACHE || settings.DISTILL_ADAPTIVE) {
    const uses = [settings.SEMCACHE && 'the semantic cache', settings.DISTILL_ADAPTIVE && 'adaptive tool-output shrinking'].filter(Boolean);
    models.push({ name: settings.EMBED_MODEL, setting: 'EMBED_MODEL', purpose: uses.join(' and ') });
  }
  return models;
}
