/**
 * @fileoverview Plan registry for authoritative window lengths. Window budgets are NOT
 * derived from plans: providers publish no token counts (see providers.ts).
 *
 * IMPORTANT MAINTAINER WARNING:
 * Providers change these limits often. Re-verify the numbers against the cited sources!
 *
 * Sources:
 *   claude  : https://support.claude.com/en/articles/11049741-what-is-the-max-plan
 *   chatgpt : https://help.openai.com          (search "ChatGPT usage limits")
 *   gemini  : https://support.google.com/gemini/answer/16275805
 */

export interface SubscriptionPlan {
  provider: 'claude' | 'chatgpt' | 'gemini';
  windowMinutes: number;
  source: string;
  verifiedOn: string;
  note?: string;
}

export type RawPlanDef = {
  provider: 'claude' | 'chatgpt' | 'gemini';
  windowMinutes: number;
};

// Define raw constants as pinned by research
const RAW_PLANS: Record<string, RawPlanDef> = {
  // CLAUDE — 5h rolling window + weekly cap
  'claude-pro':      { provider: 'claude', windowMinutes: 300 },
  'claude-max-5x':   { provider: 'claude', windowMinutes: 300 },
  'claude-max-20x':  { provider: 'claude', windowMinutes: 300 },

  // CHATGPT — 3h rolling window
  'chatgpt-go':      { provider: 'chatgpt', windowMinutes: 180 },
  'chatgpt-plus':    { provider: 'chatgpt', windowMinutes: 180 },
  'chatgpt-pro-5x':  { provider: 'chatgpt', windowMinutes: 180 },
  'chatgpt-pro-20x': { provider: 'chatgpt', windowMinutes: 180 },

  // GEMINI — 5h compute-based rolling window + weekly
  'gemini-plus':     { provider: 'gemini', windowMinutes: 300 },
  'gemini-pro':      { provider: 'gemini', windowMinutes: 300 },
  'gemini-ultra':    { provider: 'gemini', windowMinutes: 300 },
};

const SOURCES: Record<'claude' | 'chatgpt' | 'gemini', string> = {
  claude: 'https://support.claude.com/en/articles/11049741-what-is-the-max-plan',
  chatgpt: 'https://help.openai.com',
  gemini: 'https://support.google.com/gemini/answer/16275805'
};

/**
 * Returns a fully resolved subscription plan.
 */
export function getSubscriptionPlan(
  planKey: string
): SubscriptionPlan {
  const raw = RAW_PLANS[planKey];
  if (!raw) {
    throw new Error(`Unknown plan key: '${planKey}'. Valid keys: ${Object.keys(RAW_PLANS).join(', ')}`);
  }

  return {
    provider: raw.provider,
    windowMinutes: raw.windowMinutes,
    source: SOURCES[raw.provider],
    verifiedOn: '2026-09-09'
  };
}

export function isValidPlanKey(planKey: string): boolean {
  return planKey in RAW_PLANS;
}

export function getValidPlanKeys(): string[] {
  return Object.keys(RAW_PLANS);
}
