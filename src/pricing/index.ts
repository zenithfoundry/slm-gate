/**
 * USD per 1,000,000 tokens (standard, non-batch, non-cached input).
 *
 * Verified against provider documentation on 2026-09-13:
 *   OpenAI    https://developers.openai.com/api/docs/pricing
 *   Anthropic https://platform.claude.com/docs/en/about-claude/models/overview
 *   Google    https://ai.google.dev/gemini-api/docs/pricing
 *
 * Re-verify before trusting cost figures: providers change these often, and a stale rate
 * silently corrupts every "Cost Saved" number on the dashboard.
 */
export const PRICING: Record<string, { in: number; out: number }> = {
  // ── OpenAI ──
  'gpt-6-astra': { in: 10, out: 50 },
  'gpt-5.6-sol': { in: 4, out: 20 },      // promotional through 2026-11-21
  'gpt-5.6-terra': { in: 2, out: 12 },
  'gpt-5.6-luna': { in: 0.20, out: 1.20 },
  'gpt-5.6-cyber': { in: 12.50, out: 75 },

  // ── Anthropic ──
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },

  // ── Google ──
  // 3.8/3.7/3.6 Flash share promotional pricing through 2026-12-31,
  // after which input rises to 1.50 and output to 7.50.
  'gemini-3.8-flash': { in: 0.75, out: 3.75 },
  'gemini-3.7-flash': { in: 0.75, out: 3.75 },
  'gemini-3.6-flash': { in: 0.75, out: 3.75 },
  'gemini-3.5-flash': { in: 1.50, out: 9.00 },
  'gemini-3.5-flash-lite': { in: 0.30, out: 2.50 },
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.50 },
  // Pro preview is tiered: these are the <=200k-token prompt rates.
  'gemini-3.1-pro-preview': { in: 2.00, out: 12.00 },

  // Retired 2026-10-16 (Gemini Developer API). Retained only so historical ledger rows
  // still price correctly; do not use for new traffic.
  'gemini-2.5-pro': { in: 1.25, out: 10.00 },
  'gemini-2.5-flash': { in: 0.30, out: 2.50 },
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40 },
  'gemini-2.5-flash-free': { in: 0, out: 0 },

  // To add a model, use its exact API id and cite the pricing page above.
};

export const LOCAL_RATE = { in: 0, out: 0 };

export function isLocal(model: string): boolean {
  // Keep as ONLY a fallback guess. The real decision is explicit in the ledger caller.
  if (model.startsWith('local:')) return true;
  const lower = model.toLowerCase();
  // 'gemma' deliberately excluded: providerFromModel() classifies it as the Gemini
  // provider, so treating it as local here made cost and provider attribution disagree.
  // A genuinely local gemma should be tagged 'local:' by the caller.
  return ['qwen', 'llama', 'phi', 'mistral', 'deepseek'].some(tag => lower.includes(tag));
}

/**
 * Strips host-specific decorations from a model id so it matches a PRICING key.
 *
 * Agents report ids like `claude-opus-5[1m]` (context-window suffix) or
 * `anthropic/claude-sonnet-5` (vendor-prefixed router style). Without normalisation these
 * all missed the table and silently fell back to the reference cloud model's rates.
 *
 * @param model Raw model id as reported by the host
 * @returns Normalised id suitable for a PRICING lookup
 */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .replace(/\[[^\]]*\]$/, '')      // trailing [1m] context-window marker
    .replace(/^[^/]+\//, '')          // vendor/ prefix
    .replace(/[:@](latest|preview)$/, '')
    .trim();
}

export function ratesFor(model: string): { in: number; out: number } {
  if (model in PRICING) {
    return PRICING[model];
  }
  const normalized = normalizeModelId(model);
  if (normalized in PRICING) {
    return PRICING[normalized];
  }
  // Longest-prefix match so dated snapshots (claude-opus-5-20260401) resolve to their family.
  const prefixMatch = Object.keys(PRICING)
    .filter(key => normalized.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  if (prefixMatch) {
    return PRICING[prefixMatch];
  }
  const known = Object.keys(PRICING).join(', ');
  const error = new Error(`Pricing missing for model: ${model}. Known API models are: ${known}`);
  error.name = 'PricingMissingError';
  throw error;
}

export function calculateCostUsd(model: string, inTok: number, outTok: number): number {
  let rate;
  if (isLocal(model)) {
    rate = LOCAL_RATE;
  } else {
    rate = ratesFor(model);
  }

  return (inTok * rate.in + outTok * rate.out) / 1e6;
}

export function safeCalculateCostUsd(model: string | undefined, inTok: number, outTok: number, fallbackModel = 'gemini-2.5-flash'): number {
  const target = model || fallbackModel;
  try {
    return calculateCostUsd(target, inTok, outTok);
  } catch {
    try {
      return calculateCostUsd(fallbackModel, inTok, outTok);
    } catch {
      return 0;
    }
  }
}

