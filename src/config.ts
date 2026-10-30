/**
 * Loads this install's `.env` (never the workspace's) and exposes the frozen CONFIG every module reads.
 * The only module allowed to read `process.env`: everything the gates take from the environment is a key of
 * `envSchema`, which is also what `.env.example` must list (tests/config/env-template.test.ts) and what the
 * MCP server strips before it starts the shared model gate (src/setup/model-gate.ts).
 */
import { config } from 'dotenv';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { ramPresets } from './hardware.js';
import { resolveHomeDir } from './home-dir.js';
import { getSubscriptionPlan, getValidPlanKeys, isValidPlanKey, type ProviderId } from './pricing/plans.js';
import { isEntryPoint } from './utils/entry-point.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const ROOT_DIR = path.resolve(dirname, '..');
// Settings and data (.env, output/): the checkout for a git clone, ~/.slm-gate for an npm install,
// or SLM_GATE_HOME (src/home-dir.ts).
const HOME_DIR = resolveHomeDir({ installDir: ROOT_DIR, env: process.env, userHome: os.homedir() });
const OUTPUT_DIR = path.join(HOME_DIR, 'output');

// Load THIS INSTALL'S .env, from HOME_DIR. Deliberately not cwd-relative:
// MCP hosts spawn the gate with cwd set to whatever workspace the user has open, so a
// bare dotenv.config() silently found nothing and left LANGFUSE_*/PROVIDER undefined
// while LEDGER_PATH's module-relative default still resolved — a gate that looked
// healthy and shipped no telemetry.
//
// The caller's cwd .env is deliberately NOT loaded as a fallback: it would pull an
// unrelated project's PROVIDER, CLOUD_API_KEY and CLOUD_MODEL into this process.
// Host-supplied process.env still wins, because dotenv never overrides an existing var.
const envFile = config({ path: path.join(HOME_DIR, '.env') });

// Zod pre-processors for env strings
const parseInteger = (fallback: number) => z.string().optional().transform(v => v ? parseInt(v, 10) : fallback);
// Blank stays undefined: the default is worked out below from another setting.
const parseDerivedInteger = () => z.string().optional().transform(v => v ? parseInt(v, 10) : undefined);
const parseFloatNumber = (fallback: number) => z.string().optional().transform(v => v ? parseFloat(v) : fallback);
const parseBoolean = (fallback: boolean) => z.string().optional().transform(v => {
  if (!v) return fallback;
  return v.toLowerCase() === 'on' || v.toLowerCase() === 'true' || v === '1';
});
const parseNumberArray = (fallback: number[]) => z.string().optional().transform(v => v ? v.split(',').map(n => parseInt(n.trim(), 10)) : fallback);
// The toolbox to proxy: a command to start (stdio) or a URL (streamable HTTP). Anything else stops slm-gate
// here, naming the setting, instead of silently running standalone.
const downstreamMcpSchema = z.union([
  z.object({ command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string()).optional() }),
  z.object({ url: z.string().url(), headers: z.record(z.string()).optional() }),
]);
export type DownstreamMcp = z.infer<typeof downstreamMcpSchema>;
const parseDownstreamMcp = () => z.string().optional().transform((v, ctx): DownstreamMcp | null => {
  if (!v) return null;
  let json: unknown;
  try {
    json = JSON.parse(v);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'DOWNSTREAM_MCP is not valid JSON' });
    return z.NEVER;
  }
  const parsed = downstreamMcpSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'DOWNSTREAM_MCP must be {"command": "...", "args": [...], "env": {...}} or {"url": "...", "headers": {...}}' });
  return z.NEVER;
});

export const envSchema = z.object({
  // STEP 1
  SLM_PROVIDER: z.enum(['ollama', 'openai']).default('ollama'),
  OLLAMA_HOST: z.string().default('http://localhost:11434'),
  OLLAMA_KEEP_ALIVE: z.string().default('12h'),
  // Conversation memory (docs/briefs/2026-10-22-conversation-memory.md): the model gate keeps a short running
  // summary per conversation, folded by the brain model off the request path, for the local steps to read.
  // On by default: every reader fails closed without a usable summary, so nothing changes until a fold lands.
  CONVERSATION_MEMORY: parseBoolean(true),
  // The summary's size, the most new text one fold reads, how often a conversation may fold, and how old a
  // summary may be before every reader ignores it. The first two must fit NUM_CTX with the answer, so blank
  // means the value for this NUM_CTX (see CONFIG below).
  MEMORY_MAX_TOKENS: parseDerivedInteger(),
  MEMORY_FOLD_INPUT_TOKENS: parseDerivedInteger(),
  MEMORY_FOLD_INTERVAL_MS: parseInteger(20000),
  MEMORY_MATCH_WINDOW_MS: parseInteger(600000),
  // Keep the two local models loaded: when a model slm-gate does not use displaces one of its own, unload
  // the stranger and warm the missing one back in (src/models/pin.ts). Off leaves Ollama's memory alone.
  SLM_PIN_MODELS: parseBoolean(true),
  SLM_BRAIN_MODEL: z.string().optional(), // resolved below
  SLM_GATE_MODEL: z.string().optional(),  // resolved below
  NUM_CTX: parseInteger(8192),
  TEMPERATURE: parseFloatNumber(0),
  SLM_TIMEOUT_MS: parseInteger(120000),
  SELF_CONSISTENCY_K: parseInteger(3),
  SELF_CONSISTENCY_TEMP: parseFloatNumber(0.7),

  // STEP 2
  CLOUD_API_STYLE: z.enum(['openai', 'anthropic']).default('openai'),
  CLOUD_BASE_URL: z.string().optional(),
  CLOUD_API_KEY: z.string().optional(),
  CLOUD_MODEL: z.string().optional(),

  // Semantic CACHE
  SEMCACHE: parseBoolean(false),
  SEMCACHE_THRESHOLD: parseFloatNumber(0.95),
  EMBED_MODEL: z.string().default('nomic-embed-text'),

  // STEP 3
  LLM_GATE_PORT: parseInteger(8787),
  // When a coding tool starts slm-gate's MCP server, also start the model gate (in the background) if it
  // is not running, and keep it running while tools are open. Off = you start it yourself (`slm-gate start`).
  LLM_GATE_AUTOSTART: parseBoolean(true),
  // Distil large command, search and listing tool results before requests leave the machine. Off makes
  // the gate a plain pass-through; ongoing conversations then resend their distilled history in full
  // once (one prompt-cache miss, and Claude drops its earlier thinking once).
  LLM_GATE_DISTILL: parseBoolean(true),
  // Where the model gate forwards each wire format. Built in; override only when your requests
  // must already go through a company gateway. The tool's own login is forwarded either way.
  UPSTREAM_ANTHROPIC_URL: z.string().url().default('https://api.anthropic.com'),
  UPSTREAM_OPENAI_URL: z.string().url().default('https://api.openai.com/v1'),
  UPSTREAM_CHATGPT_URL: z.string().url().default('https://chatgpt.com/backend-api/codex'),
  UPSTREAM_GEMINI_URL: z.string().url().default('https://generativelanguage.googleapis.com'),
  DOWNSTREAM_MCP: parseDownstreamMcp(),
  MCP_GATE_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_GATE_PORT: parseInteger(8788),

  // STEP 4
  PROVIDER: z.enum(['gemini', 'claude', 'chatgpt']).optional(),
  LEDGER_PATH: z.string().default(path.join(OUTPUT_DIR, 'ledger.sqlite')),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().optional(),
  // Langfuse environment dimension. Keeps synthetic runs out of the real
  // traffic view — the dashboard's Env selector filters on this. Langfuse requires
  // lowercase alphanumeric plus - and _, and forbids the 'langfuse' prefix.
  // Not 'default': that is where any other writer to the same Langfuse project lands
  // when it sets no environment, so the gate's traffic would be mixed with theirs.
  LANGFUSE_ENVIRONMENT: z.string()
    .regex(/^(?!langfuse)[a-z0-9_-]+$/, "LANGFUSE_ENVIRONMENT must be lowercase alphanumeric (- and _ allowed) and must not start with 'langfuse'")
    .default('slm-gate'),
  SUBSCRIPTION_PLAN: z.string().optional(),
  PLAN_CLAUDE: z.string().optional(),
  PLAN_CHATGPT: z.string().optional(),
  PLAN_GEMINI: z.string().optional(),
  // Usage-window budgets for the savings cards (src/pricing/providers.ts): tokens per window for Claude and
  // Gemini, messages per window for ChatGPT. Blank = the estimate for the plan named above, or no card at all
  // when no plan is named: the gate never invents a budget.
  CLAUDE_WINDOW_BUDGET: z.coerce.number().int().positive().optional(),
  CHATGPT_WINDOW_BUDGET: z.coerce.number().int().positive().optional(),
  GEMINI_WINDOW_BUDGET: z.coerce.number().int().positive().optional(),
  // A JSON file that overrides the built-in provider registry (window lengths, model name patterns).
  PROVIDER_REGISTRY_PATH: z.string().optional(),

  // STEP 5
  RESOLVER_CLOUD_TIER: parseBoolean(false),
  RESOLVER_CLOUD_BUDGET_USD: parseFloatNumber(0),
  // The most skill text the resolver puts in one local-model prompt; longer skills are trimmed by section.
  // Blank means the value for this NUM_CTX (see CONFIG below).
  RESOLVER_PROMPT_TOKENS: parseDerivedInteger(),
  // Part of every cache key. The shipped value: a settings file without it must hit the same cache rows as
  // one written by `slm-gate init`.
  PROMPT_VERSION: z.string().default('v12'),
  // The presets in src/hardware.ts ramPresets. Every value recommendPreset() can print must be accepted
  // here, or following doctor's advice stops slm-gate from starting. slm-gate needs 16 GB of RAM or more.
  RAM_PRESET: z.enum(['ram-16', 'ram-24', 'ram-32', 'ram-48', 'ram-64', 'ram-128', 'custom']).default('custom'),
  TLS_ADAPTER: parseBoolean(false),
  // A relative path is read from the install folder, where configs/ ships: the MCP server runs in whatever
  // folder the coding tool has open, so resolving it against the working folder never found the default.
  DISTILL_PRESERVE_PATH: z.string().optional().transform(v => v?.trim() ? path.resolve(ROOT_DIR, v.trim()) : null),
  DISTILL_PRESERVE_MODE: z.enum(['extend', 'replace']).default('extend'),
  DISTILL_SKILLS: parseBoolean(false),
  // Repository symbol index: the find_existing tool, index-backed resolver evidence and the
  // "Existing code that may already cover this" section on conditioned skills. Disk only, no model.
  REPO_INDEX: parseBoolean(false),
  DISTILL_ADAPTIVE: parseBoolean(false),
  DISTILL_ADAPTIVE_THRESHOLD: parseFloatNumber(0.86),
  DISTILL_ADAPTIVE_EXPLORE_RATE: parseFloatNumber(0.15),
  DISTILL_MAX_TOKENS: parseInteger(2000),
  DISTILL_MIN_TOKENS: parseInteger(500),
  // How long the model gate may hold one request to distil its new tool results. Past it, a result is
  // sent (and kept, forever) as the original. Warm local-model runs take ~0.5 s per ~600 words.
  DISTILL_BUDGET_MS: parseInteger(3000),
  // Skill shrinking fidelity guard. A compressed prose run is kept only when the brain model
  // confirms every code-listed requirement sentence survived: recall >= MIN (1.0 = nothing missing).
  DISTILL_FIDELITY_MIN: parseFloatNumber(1.0),
  // At most this many prose runs per document are compressed and checked; the rest stay verbatim.
  DISTILL_FIDELITY_MAX_RUNS: parseInteger(8),
  // Wall-clock budget for one document's shrinking; runs past it stay verbatim.
  DISTILL_FIDELITY_BUDGET_MS: parseInteger(60000),
  // Prose runs the gate model shortens at the same time. One GPU: two calls share it, so 2 is not twice as
  // fast as 1; `pnpm run bench:gate` measures both on this machine.
  MAX_CONCURRENT_SEGMENT_CALLS: parseInteger(2),
  ELISION_RETENTION_DAYS: parseInteger(180),
  ELISION_MAX_MB: parseInteger(500),
  // How many days of data your Langfuse plan keeps (Hobby: 30). Only the dashboard text reads it: the
  // cards cover this rolling window, while the local ledger keeps everything.
  LANGFUSE_RETENTION_DAYS: parseInteger(30),

});

// A variable that is present but blank means "unset". dotenv and MCP-host env blocks both
// deliver `LEDGER_PATH=` (as shipped in every .env template) as '', and zod's .default() only
// fires on undefined — so a blank value used to defeat the absolute default and leave a
// cwd-relative './output/ledger.sqlite', which ENOENTs when the host's cwd does not exist
// (Claude Desktop). Dropping empties here fixes that for every variable in one place.
const envInput = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));

/**
 * Every environment variable slm-gate's configuration reads. The automatically started model gate is
 * launched without these, so it takes its settings only from slm-gate's own .env — never from the MCP env
 * block of whichever coding tool happened to start it (src/setup/model-gate.ts).
 */
export const CONFIG_ENV_KEYS: readonly string[] = Object.keys(envSchema.shape);
const parsedEnv = envSchema.parse(envInput);

const preset = ramPresets[parsedEnv.RAM_PRESET] || ramPresets['custom'];

const DEFAULT_PLANS: Record<ProviderId, string> = { claude: 'claude-pro', chatgpt: 'chatgpt-plus', gemini: 'gemini-pro' };

/**
 * The plan behind a provider's usage window: PLAN_<PROVIDER>, else SUBSCRIPTION_PLAN when it names this
 * provider, else the provider's base plan. Only a plan the user named carries a window-budget estimate: the
 * savings cards stay empty rather than show minutes for a plan nobody chose.
 */
const resolvePlan = (provider: ProviderId) => {
  const named = parsedEnv[`PLAN_${provider.toUpperCase()}` as 'PLAN_CLAUDE' | 'PLAN_CHATGPT' | 'PLAN_GEMINI']
    || (parsedEnv.SUBSCRIPTION_PLAN?.startsWith(provider) ? parsedEnv.SUBSCRIPTION_PLAN : undefined);
  const planKey = named || DEFAULT_PLANS[provider];
  if (!isValidPlanKey(planKey)) {
    throw new Error(`Invalid plan key '${planKey}' for ${provider}. Valid keys: ${getValidPlanKeys().join(', ')}`);
  }
  const resolved = getSubscriptionPlan(planKey);
  return {
    windowMinutes: resolved.windowMinutes,
    source: resolved.source,
    plan: planKey,
    windowBudget: named ? resolved.windowBudget : null,
  };
};

const claudePlan = resolvePlan('claude');
const chatgptPlan = resolvePlan('chatgpt');
const geminiPlan = resolvePlan('gemini');

// Three prompt budgets that must fit NUM_CTX next to the answer: the smaller values are for the 16 GB preset
// (NUM_CTX 4096), where the larger ones made Ollama cut prompts silently.
const roomy = parsedEnv.NUM_CTX >= 8192;

export const CONFIG = Object.freeze({
  ...parsedEnv,
  ROOT_DIR,
  HOME_DIR,
  OUTPUT_DIR,
  SLM_BRAIN_MODEL: parsedEnv.SLM_BRAIN_MODEL || preset.brain,
  SLM_GATE_MODEL: parsedEnv.SLM_GATE_MODEL || preset.gate,
  MEMORY_MAX_TOKENS: parsedEnv.MEMORY_MAX_TOKENS ?? (roomy ? 400 : 300),
  MEMORY_FOLD_INPUT_TOKENS: parsedEnv.MEMORY_FOLD_INPUT_TOKENS ?? (roomy ? 3000 : 2000),
  RESOLVER_PROMPT_TOKENS: parsedEnv.RESOLVER_PROMPT_TOKENS ?? (roomy ? 3000 : 2000),
  // Where every session looks for, and starts, the one shared model gate: LLM_GATE_PORT as slm-gate's own
  // .env sets it. LLM_GATE_PORT above prefers the process environment, so a value in one coding tool's MCP
  // env block (or the shell) would send that session to another port, where it would start a second gate.
  MODEL_GATE_PORT: envSchema.shape.LLM_GATE_PORT.parse(envFile.parsed?.LLM_GATE_PORT || undefined),
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
if (isEntryPoint(import.meta.url)) {
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
  console.log(`brain: ${CONFIG.SLM_BRAIN_MODEL} | gate: ${CONFIG.SLM_GATE_MODEL}`);
  for (const plan of [claudePlan, chatgptPlan, geminiPlan]) {
    console.log(`plan: ${plan.plan} (${plan.windowMinutes} min window, budget ${plan.windowBudget ?? 'not set'})`);
  }
  
  const downstream = CONFIG.DOWNSTREAM_MCP ? ('command' in CONFIG.DOWNSTREAM_MCP ? `command: ${CONFIG.DOWNSTREAM_MCP.command}` : `url: ${CONFIG.DOWNSTREAM_MCP.url}`) : 'standalone';
  console.log(`downstream: ${downstream}`);
  
  const sinks = ['sqlite'];
  if (CONFIG.LANGFUSE_PUBLIC_KEY && CONFIG.LANGFUSE_SECRET_KEY && CONFIG.LANGFUSE_HOST) {
    sinks.push('langfuse');
  }
  console.log(`sinks: [${sinks.join(', ')}]`);
}
