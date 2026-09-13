import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { isValidPlanKey, getSubscriptionPlan, getValidPlanKeys } from './pricing/plans.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const ROOT_DIR = path.resolve(dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');

// Load THIS PACKAGE'S .env, resolved module-relative. Deliberately not cwd-relative:
// MCP hosts spawn the gate with cwd set to whatever workspace the user has open, so a
// bare dotenv.config() silently found nothing and left LANGFUSE_*/PROVIDER undefined
// while LEDGER_PATH's module-relative default still resolved — a gate that looked
// healthy and shipped no telemetry.
//
// The caller's cwd .env is deliberately NOT loaded as a fallback: it would pull an
// unrelated project's PROVIDER, CLOUD_API_KEY and CLOUD_MODEL into this process.
// Host-supplied process.env still wins, because dotenv never overrides an existing var.
config({ path: path.join(ROOT_DIR, '.env') });

// Zod pre-processors for env strings
const parseInteger = (fallback: number) => z.string().optional().transform(v => v ? parseInt(v, 10) : fallback);
const parseFloatNumber = (fallback: number) => z.string().optional().transform(v => v ? parseFloat(v) : fallback);
const parseBoolean = (fallback: boolean) => z.string().optional().transform(v => {
  if (!v) return fallback;
  return v.toLowerCase() === 'on' || v.toLowerCase() === 'true' || v === '1';
});
const parseNumberArray = (fallback: number[]) => z.string().optional().transform(v => v ? v.split(',').map(n => parseInt(n.trim(), 10)) : fallback);
const parseStringArray = (fallback: string[]) => z.string().optional().transform(v => v ? v.split(',').map(s => s.trim()) : fallback);
const parseDownstreamMcp = () => z.string().optional().transform(v => {
  if (!v) return null;
  try {
    const parsed = JSON.parse(v);
    if (parsed.command) {
      return { command: parsed.command, args: parsed.args, env: parsed.env } as any;
    }
    if (parsed.url) {
      return { url: parsed.url, headers: parsed.headers } as any;
    }
    return null;
  } catch {
    return null;
  }
});

const envSchema = z.object({
  // STEP 1
  SLM_PROVIDER: z.enum(['ollama', 'openai']).default('ollama'),
  OLLAMA_HOST: z.string().default('http://localhost:11434'),
  OLLAMA_KEEP_ALIVE: z.string().default('12h'),
  SLM_BRAIN_MODEL: z.string().optional(), // resolved below
  SLM_GATE_MODEL: z.string().optional(),  // resolved below
  SLM_GATE_TESTING_MODEL: z.string().optional(), // resolved below, used for benchmark harness & test runs
  NUM_CTX: parseInteger(8192),
  TEMPERATURE: parseFloatNumber(0),
  SLM_TIMEOUT_MS: parseInteger(120000),
  SELF_CONSISTENCY_K: parseInteger(3),
  SELF_CONSISTENCY_TEMP: parseFloatNumber(0.7),

  // STEP 2
  STRICTNESS_LEVELS: parseNumberArray([0, 1, 2, 3, 4, 5]),
  HEADLINE_STRICTNESS: parseInteger(4),

  // STEP 3
  CLOUD_API_STYLE: z.enum(['openai', 'anthropic']).default('openai'),
  CLOUD_BASE_URL: z.string().optional(),
  CLOUD_API_KEY: z.string().optional(),
  CLOUD_MODEL: z.string().optional(),

  // Semantic CACHE
  SEMCACHE: parseBoolean(false),
  SEMCACHE_THRESHOLD: parseFloatNumber(0.95),
  EMBED_MODEL: z.string().default('nomic-embed-text'),

  // STEP 4
  LLM_GATE_PORT: parseInteger(8787),
  LLM_GATE_EXPOSE: parseStringArray(['openai', 'anthropic']),
  DOWNSTREAM_MCP: parseDownstreamMcp(),
  MCP_GATE_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_GATE_PORT: parseInteger(8788),

  // STEP 5
  PROVIDER: z.enum(['gemini', 'claude', 'chatgpt']).optional(),
  LEDGER_PATH: z.string().default(path.join(OUTPUT_DIR, 'ledger.sqlite')),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().optional(),
  // Langfuse environment dimension. Keeps benchmark/harness runs out of the real
  // traffic view — the dashboard's Env selector filters on this. Langfuse requires
  // lowercase alphanumeric plus - and _, and forbids the 'langfuse' prefix.
  LANGFUSE_ENVIRONMENT: z.string()
    .regex(/^(?!langfuse)[a-z0-9_-]+$/, "LANGFUSE_ENVIRONMENT must be lowercase alphanumeric (- and _ allowed) and must not start with 'langfuse'")
    .default('default'),
  SUBSCRIPTION_PLAN: z.string().optional(),
  PLAN_CLAUDE: z.string().optional(),
  PLAN_CHATGPT: z.string().optional(),
  PLAN_GEMINI: z.string().optional(),

  // STEP 6
  RESOLVER_CLOUD_TIER: parseBoolean(false),
  RESOLVER_CLOUD_BUDGET_USD: parseFloatNumber(0),
  PROMPT_VERSION: z.string().default('v1'),
  RAM_PRESET: z.enum(['ram-4', 'ram-8', 'ram-12', 'ram-16', 'ram-24', 'ram-32', 'custom']).default('custom'),
  TLS_ADAPTER: parseBoolean(false),
  DISTILL_PRESERVE_PATH: z.string().optional().transform(v => v?.trim() || null),
  DISTILL_PRESERVE_MODE: z.enum(['extend', 'replace']).default('extend'),
  DISTILL_SKILLS: parseBoolean(false),
  DISTILL_ADAPTIVE: parseBoolean(false),
  DISTILL_ADAPTIVE_THRESHOLD: parseFloatNumber(0.86),
  DISTILL_ADAPTIVE_EXPLORE_RATE: parseFloatNumber(0.15),
  DISTILL_FEEDBACK_RETENTION_DAYS: parseInteger(180),
  DISTILL_FEEDBACK_MAX_ROWS: parseInteger(5000),
  DISTILL_MAX_TOKENS: parseInteger(2000),
  DISTILL_MIN_TOKENS: parseInteger(500),
  KEEP_RECENT_TOOL_TURNS: parseInteger(2),
  ELISION_MAX_ENTRIES: parseInteger(5000),
  ELISION_RETENTION_DAYS: parseInteger(180),
  ELISION_MAX_MB: parseInteger(500),

  // ROUTING TUNE
  ROUTING_TUNE: parseBoolean(false),
  ROUTING_TUNE_WINDOW: parseInteger(20),
  ROUTING_TUNE_MIN_SAMPLES: parseInteger(8),
  ROUTING_TUNE_THRESHOLD: parseFloatNumber(0.5),
  ROUTING_TUNE_EXPLORE_RATE: parseFloatNumber(0.15),
});

const parsedEnv = envSchema.parse(process.env);

const ramPresets: Record<string, { brain: string, gate: string }> = {
  'ram-16':  { brain: 'qwen2.5-coder:3b', gate: 'qwen2.5-coder:0.5b' },
  'ram-24':  { brain: 'qwen3.5:4b',       gate: 'qwen2.5-coder:3b' },
  'ram-32':  { brain: 'qwen2.5:7b',       gate: 'qwen2.5-coder:3b' },
  'ram-64':  { brain: 'qwen3.5:9b',       gate: 'qwen3.5:4b' },
  'ram-128': { brain: 'qwen3:14b',        gate: 'qwen3:7b' },
  'custom':  { brain: 'qwen3.5:4b',       gate: 'qwen2.5-coder:3b' },
};

const preset = ramPresets[parsedEnv.RAM_PRESET] || ramPresets['custom'];

const resolvePlan = (provider: 'claude'|'chatgpt'|'gemini') => {
  // 1. PLAN_<P>
  const planProviderKey = `PLAN_${provider.toUpperCase()}` as keyof typeof parsedEnv;
  let planKey = parsedEnv[planProviderKey] as string | undefined;

  // 2. SUBSCRIPTION_PLAN
  if (!planKey && parsedEnv.SUBSCRIPTION_PLAN) {
    if (parsedEnv.SUBSCRIPTION_PLAN.startsWith(provider)) {
      planKey = parsedEnv.SUBSCRIPTION_PLAN;
    }
  }

  // 3. Default
  if (!planKey) {
    if (provider === 'claude') planKey = 'claude-pro';
    else if (provider === 'chatgpt') planKey = 'chatgpt-plus';
    else if (provider === 'gemini') planKey = 'gemini-pro';
  }

  if (planKey && !isValidPlanKey(planKey)) {
    throw new Error(`Invalid plan key '${planKey}' for ${provider}. Valid keys: ${getValidPlanKeys().join(', ')}`);
  }

  const resolved = getSubscriptionPlan(planKey!);
  return {
    windowMinutes: resolved.windowMinutes,
    source: resolved.source,
    plan: planKey
  };
};

const claudePlan = resolvePlan('claude');
const chatgptPlan = resolvePlan('chatgpt');
const geminiPlan = resolvePlan('gemini');

console.error(`[config] claude plan: ${claudePlan.plan} (windowMinutes: ${claudePlan.windowMinutes})`);
console.error(`[config] chatgpt plan: ${chatgptPlan.plan} (windowMinutes: ${chatgptPlan.windowMinutes})`);
console.error(`[config] gemini plan: ${geminiPlan.plan} (windowMinutes: ${geminiPlan.windowMinutes})`);

export const CONFIG = Object.freeze({
  ...parsedEnv,
  ROOT_DIR,
  OUTPUT_DIR,
  SLM_BRAIN_MODEL: parsedEnv.SLM_BRAIN_MODEL || preset.brain,
  SLM_GATE_MODEL: parsedEnv.SLM_GATE_MODEL || preset.gate,
  SLM_GATE_TESTING_MODEL: parsedEnv.SLM_GATE_TESTING_MODEL || parsedEnv.SLM_GATE_MODEL || preset.gate,
  RESOLVED_PLAN_CLAUDE: claudePlan,
  RESOLVED_PLAN_CHATGPT: chatgptPlan,
  RESOLVED_PLAN_GEMINI: geminiPlan,
});

/**
 * Validates that specific keys exist and are non-empty. Throws actionable errors if missing.
 * Called right before an operation that requires them, NOT on module boot.
 */
export function requireKeys(keys: Array<keyof typeof CONFIG>) {
  const missing = keys.filter(k => !CONFIG[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required configuration for this operation: ${missing.join(', ')}. Please update your .env file.`);
  }
}

// Config test script executed via `pnpm run config`
if (process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file://${path.resolve(process.argv[1])}`)) {
  console.log('=== SMALL-LANGUAGE-MODEL-GATE CONFIGURATION ===');
  
  const redactedConfig = { ...CONFIG } as any;
  if (redactedConfig.CLOUD_API_KEY) redactedConfig.CLOUD_API_KEY = '<SET>';
  else redactedConfig.CLOUD_API_KEY = '<UNSET>';
  
  if (redactedConfig.LANGFUSE_SECRET_KEY) redactedConfig.LANGFUSE_SECRET_KEY = '<SET>';
  else redactedConfig.LANGFUSE_SECRET_KEY = '<UNSET>';

  if (redactedConfig.LANGFUSE_PUBLIC_KEY) redactedConfig.LANGFUSE_PUBLIC_KEY = '<SET>';
  else redactedConfig.LANGFUSE_PUBLIC_KEY = '<UNSET>';

  console.log(JSON.stringify(redactedConfig, null, 2));

  console.log('\n--- Summary ---');
  console.log(`brain: ${CONFIG.SLM_BRAIN_MODEL} | gate: ${CONFIG.SLM_GATE_MODEL} | test: ${CONFIG.SLM_GATE_TESTING_MODEL}`);
  
  const downstream = CONFIG.DOWNSTREAM_MCP ? (CONFIG.DOWNSTREAM_MCP.command ? `command: ${CONFIG.DOWNSTREAM_MCP.command}` : `url: ${CONFIG.DOWNSTREAM_MCP.url}`) : 'standalone';
  console.log(`downstream: ${downstream}`);
  
  const sinks = ['sqlite'];
  if (CONFIG.LANGFUSE_PUBLIC_KEY && CONFIG.LANGFUSE_SECRET_KEY && CONFIG.LANGFUSE_HOST) {
    sinks.push('langfuse');
  }
  console.log(`sinks: [${sinks.join(', ')}]`);
}
