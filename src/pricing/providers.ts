/**
 * @fileoverview Provider registry — the single, data-driven source of truth for how each
 * subscription provider meters its rolling usage window, and how to recognise one.
 *
 * Two problems this replaces:
 *
 * 1. Provider/agent detection was hard-coded substring matching inside ledger/index.ts, so
 *    supporting a new host or vendor meant editing code and cutting a release.
 *
 * 2. "Cycle Extended (min)" was computed as `windowMinutes * (tokensSaved / baselineTokens)`.
 *    That multiplies a PER-EVENT COMPRESSION RATIO by a GLOBAL WINDOW LENGTH, which is
 *    dimensionally meaningless — it claimed a single tool call that compressed 4,511 tokens
 *    to 1,825 freed 178 of 300 window minutes, i.e. two such calls would free the entire
 *    window. Converting savings into minutes requires a RATE:
 *
 *        minutesFreed = unitsSaved / (windowBudget / windowMinutes)
 *
 *    where the unit depends on how the provider actually meters:
 *      - 'compute' providers bill tokens  -> unitsSaved = tokens saved
 *      - 'message' providers bill requests -> unitsSaved = requests never sent (defer_local)
 *
 *    `windowBudget` is a real quantity the operator must supply; it is NOT knowable from
 *    inside the gate. When it is unset we emit NO score rather than inventing one.
 *
 * Override the built-in defaults by pointing PROVIDER_REGISTRY_PATH at a JSON file with the
 * same shape. Keys are provider ids; unknown ids are accepted, which is what keeps the gate
 * agent- and vendor-agnostic.
 */

import fs from 'node:fs';

export type MeteringModel = 'message' | 'compute';

/**
 * Shortest permitted match pattern. Matching is substring-based, so two-character needles
 * (the retired 'o1'/'o3'/'o4' OpenAI patterns) collide with unrelated model ids.
 */
const MIN_PATTERN_LENGTH = 3;

export interface ProviderProfile {
  /** Rolling window length in minutes. */
  windowMinutes: number;
  /** Whether the window is consumed per request or per token. */
  metering: MeteringModel;
  /**
   * Units available per window: messages for 'message' metering, tokens for 'compute'.
   * `null` means unknown — cycle extension is then not computable and no score is emitted.
   */
  windowBudget: number | null;
  /** Lowercased substrings that identify this provider from a model id. */
  modelPatterns: string[];
  /** Lowercased substrings that identify this provider from a host/agent name. */
  agentPatterns: string[];
}

export const DEFAULT_PROVIDER_REGISTRY: Record<string, ProviderProfile> = {
  claude: {
    windowMinutes: 300,
    metering: 'message',
    windowBudget: null,
    // 'fable' and 'mythos' are current frontier families (claude-fable-5-1); they are NOT
    // covered by the opus/sonnet/haiku tier names. Verified against platform.claude.com
    // 2026-09-13.
    modelPatterns: ['claude', 'anthropic', 'fable', 'mythos', 'opus', 'sonnet', 'haiku'],
    agentPatterns: ['claude'],
  },
  chatgpt: {
    windowMinutes: 180,
    metering: 'message',
    windowBudget: null,
    // The o-series (o1/o3/o4) is RETIRED — OpenAI merged reasoning into the unified GPT
    // line. Those patterns were also unsafe here: matching is substring-based, so a
    // two-character needle like 'o1' can collide with unrelated ids.
    // Every current text model is 'gpt-*' (gpt-6-astra, gpt-5.6-sol/terra/luna/cyber)
    // EXCEPT the daybreak-red / daybreak-blue security aliases, which contain neither
    // 'gpt' nor 'openai' and were previously unattributable.
    // Verified against developers.openai.com/api/docs/models 2026-09-13.
    modelPatterns: ['gpt', 'openai', 'daybreak', 'codex'],
    agentPatterns: ['chatgpt', 'openai', 'codex'],
  },
  gemini: {
    windowMinutes: 300,
    metering: 'compute',
    windowBudget: null,
    // 'bison' is retained only for PaLM-era ids; all current models are gemini-*/gemma-*.
    modelPatterns: ['gemini', 'gemma', 'bison'],
    agentPatterns: ['antigravity', 'gemini'],
  },
};

let cachedRegistry: Record<string, ProviderProfile> | null = null;

/**
 * Returns the active provider registry, loading a JSON override once if configured.
 *
 * @param overridePath Optional path to a JSON registry; defaults to PROVIDER_REGISTRY_PATH.
 * @returns Provider id -> profile.
 */
export function getProviderRegistry(overridePath = process.env.PROVIDER_REGISTRY_PATH): Record<string, ProviderProfile> {
  if (cachedRegistry) return cachedRegistry;

  // Clone each profile: a shallow spread would share the profile objects with
  // DEFAULT_PROVIDER_REGISTRY, so writing windowBudget below would permanently mutate the
  // module-level defaults and survive every subsequent reset.
  const registry: Record<string, ProviderProfile> = Object.fromEntries(
    Object.entries(DEFAULT_PROVIDER_REGISTRY).map(([id, profile]) => [id, { ...profile }])
  );
  if (overridePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(overridePath, 'utf-8')) as Record<string, Partial<ProviderProfile>>;
      for (const [id, profile] of Object.entries(parsed)) {
        registry[id] = { ...(registry[id] ?? DEFAULT_PROVIDER_REGISTRY.claude), ...profile } as ProviderProfile;
      }
      // Matching is substring-based, so a very short needle silently mis-attributes
      // unrelated models. This is how the retired 'o1'/'o3'/'o4' patterns became a hazard.
      for (const [id, profile] of Object.entries(registry)) {
        for (const pattern of [...profile.modelPatterns, ...profile.agentPatterns]) {
          if (pattern.length < MIN_PATTERN_LENGTH) {
            console.error(`[providers] Ignoring pattern '${pattern}' for '${id}': patterns must be at least ${MIN_PATTERN_LENGTH} characters to avoid false matches.`);
          }
        }
        profile.modelPatterns = profile.modelPatterns.filter(p => p.length >= MIN_PATTERN_LENGTH);
        profile.agentPatterns = profile.agentPatterns.filter(p => p.length >= MIN_PATTERN_LENGTH);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[providers] Could not read PROVIDER_REGISTRY_PATH (${overridePath}): ${message}. Using defaults.`);
    }
  }

  // Window budgets are operator-supplied, per provider, via env.
  // e.g. CLAUDE_WINDOW_BUDGET=250  (messages per 5h window)
  //      GEMINI_WINDOW_BUDGET=2000000  (tokens per 5h window)
  for (const id of Object.keys(registry)) {
    const raw = process.env[`${id.toUpperCase()}_WINDOW_BUDGET`];
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) registry[id].windowBudget = parsed;
    }
  }

  cachedRegistry = registry;
  return registry;
}

/** Test hook: forces the registry to be re-read on next access. */
export function __resetProviderRegistry(): void {
  cachedRegistry = null;
}

/**
 * Identifies the provider behind a model id.
 *
 * @param model Model id as reported by the host, e.g. 'claude-opus-5[1m]'
 * @returns Provider id, or null when nothing matches.
 */
export function providerFromModelId(model?: string): string | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  for (const [id, profile] of Object.entries(getProviderRegistry())) {
    if (profile.modelPatterns.some(p => lower.includes(p))) return id;
  }
  return null;
}

/**
 * Identifies the provider behind a host/agent name.
 *
 * @param agent Agent or host identifier, e.g. 'claude-code'
 * @returns Provider id, or null when nothing matches.
 */
export function providerFromAgentName(agent?: string): string | null {
  if (!agent) return null;
  const lower = agent.toLowerCase();
  for (const [id, profile] of Object.entries(getProviderRegistry())) {
    if (profile.agentPatterns.some(p => lower.includes(p))) return id;
  }
  return null;
}
