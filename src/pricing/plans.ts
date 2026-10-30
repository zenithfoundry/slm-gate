/**
 * @fileoverview Plan registry: the window length of every subscription plan slm-gate knows, and where one is
 * known, an estimate of the window's budget (tokens, or messages for ChatGPT). The budget is an estimate
 * because providers publish only multipliers ("Max 5x = 5x Pro"), never a count; a measured
 * `*_WINDOW_BUDGET` in the settings file always wins over it (src/pricing/providers.ts).
 *
 * IMPORTANT MAINTAINER WARNING:
 * Providers change these limits often. Re-verify the numbers against the cited sources!
 *
 * Sources:
 *   claude  : https://support.claude.com/en/articles/11049741-what-is-the-max-plan
 *   chatgpt : https://help.openai.com          (search "ChatGPT usage limits")
 *   gemini  : https://support.google.com/gemini/answer/16275805
 */

/** The subscription providers whose usage windows the savings cards model. */
export type ProviderId = 'claude' | 'chatgpt' | 'gemini';

export interface SubscriptionPlan {
  provider: ProviderId;
  windowMinutes: number;
  /** Estimated units per window (tokens; messages for ChatGPT), or null when no estimate is known. */
  windowBudget: number | null;
  source: string;
  verifiedOn: string;
  note?: string;
}

export type RawPlanDef = {
  provider: ProviderId;
  windowMinutes: number;
  windowBudget: number | null;
};

// Define raw constants as pinned by research. Budgets: Claude Max 5x measured 2026-09-16 from Claude Code
// usage logs against the /usage meter, Pro and 20x scaled by the published multipliers; ChatGPT Plus from
// third-party reports (2026); Gemini AI Pro assumed close to Claude Pro, Ultra = 20x AI Pro per Google's
// plan page. null = no figure anyone has published or measured.
const RAW_PLANS: Record<string, RawPlanDef> = {
  // CLAUDE — 5h rolling window + weekly cap
  'claude-pro':      { provider: 'claude', windowMinutes: 300, windowBudget: 460_000 },
  'claude-max-5x':   { provider: 'claude', windowMinutes: 300, windowBudget: 2_300_000 },
  'claude-max-20x':  { provider: 'claude', windowMinutes: 300, windowBudget: 9_200_000 },

  // CHATGPT — 3h rolling window for chat. Traffic that reaches the gate is Codex, which meters a
  // rolling 5h window plus a weekly cap (restored for Plus 2026-08-25; Go is included in Codex but
  // OpenAI publishes no per-window number for it). Re-verified 2026-10-21 against
  // https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan and
  // https://www.techrepublic.com/article/news-openai-five-hour-codex-limit-chatgpt-plus/
  'chatgpt-go':      { provider: 'chatgpt', windowMinutes: 300, windowBudget: null },
  'chatgpt-plus':    { provider: 'chatgpt', windowMinutes: 180, windowBudget: 160 },
  'chatgpt-pro-5x':  { provider: 'chatgpt', windowMinutes: 180, windowBudget: null },
  'chatgpt-pro-20x': { provider: 'chatgpt', windowMinutes: 180, windowBudget: null },

  // GEMINI — 5h compute-based rolling window + weekly
  'gemini-plus':     { provider: 'gemini', windowMinutes: 300, windowBudget: null },
  'gemini-pro':      { provider: 'gemini', windowMinutes: 300, windowBudget: 500_000 },
  'gemini-ultra':    { provider: 'gemini', windowMinutes: 300, windowBudget: 10_000_000 },
};

const SOURCES: Record<ProviderId, string> = {
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
    windowBudget: raw.windowBudget,
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
