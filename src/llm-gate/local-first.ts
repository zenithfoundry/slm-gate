/**
 * @fileoverview Step A: the local model answers the first request of a conversation when that is safe and
 * it can. `attemptLocalAnswer` is the one implementation: the gate calls it through
 * `answerFirstRequestLocally` (budget, cancellation, one attempt at a time) and the benchmark harness calls
 * it through `processPipeline`, so the bench measures what ships.
 *
 * A wrong local answer is worse than a cloud call — the coding tool trusts the reply — so eligibility is
 * narrow when the request lists tools (it nearly always does): only general questions and formatting, and
 * never when the typed text mentions the workspace or asks about the assistant itself. The local model sees
 * only the typed text, not the tool's system prompt or injected instructions.
 */
import { Ollama } from 'ollama';
import { checkSemanticCache, setSemanticCache } from '../cache/index.js';
import { CONFIG } from '../config.js';
import { getDb } from '../ledger/index.js';
import { handleSlmError } from '../models/helpers.js';
import { classify } from '../models/reasoning.js';
import { SLM } from '../models/slm.js';
import { verify } from '../verifier/index.js';

// The classifier's categories the local model may attempt; mirrors the schema in models/reasoning.ts
// (minus 'other'). Extending it means extending the classify() prompt too.
const ALLOWED = ['classify', 'extract', 'format', 'boolean', 'short_factual', 'trivial_edit'];
// With tools listed, only answers that cannot depend on the workspace or need a tool.
const ALLOWED_WITH_TOOLS = ['short_factual', 'format'];

const WORKSPACE_WORDS = /\b(?:repos?|repository|project|codebase|code|files?|folders?|director(?:y|ies)|dir|functions?|methods?|class(?:es)?|modules?|packages?|tests?|build|branch(?:es)?|commits?|diff|errors?|bugs?|config|scripts?|dependenc(?:y|ies)|workspace|components?|variables?)\b/i;
const FILE_NAME = /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|rb|php|cs|cpp|c|h|swift|ya?ml|toml|lock|sh|css|scss|html|sql|env|txt|xml|gradle|ini|cfg)\b/i;
const PATH = /(?:^|\s)[.~]?\/\S|\b[\w-]+\/[\w./-]+/;
const IDENTIFIER = /\b[a-z]+[A-Z]\w*\b|\b[A-Za-z]+_\w+\b|\b\w+\(\)/;
const ASKS_ABOUT_ASSISTANT = /\b(?:who|what)\s+(?:are|r)\s+(?:you|u)\b|\byour\s+(?:name|model|version|capabilit\w*|purpose|creator)\b|\bwhat\s+can\s+you\s+do\b|\b(?:what|which)\s+model\b|\byourself\b|\bare\s+you\s+(?:an?\s+)?(?:ai|bot|claude|gpt|gemini|human)\b|^\s*\/?help\b/i;

/** True when the text refers to files, code or the project, which only the tool's own model can look at. */
export function mentionsWorkspace(text: string): boolean {
  return text.includes('`') || WORKSPACE_WORDS.test(text) || FILE_NAME.test(text) || PATH.test(text) || IDENTIFIER.test(text);
}

/** True for identity and capability questions, which only the tool's own model can answer as itself. */
export function asksAboutAssistant(text: string): boolean {
  return ASKS_ABOUT_ASSISTANT.test(text);
}

/**
 * Share of recent local attempts in a category that the verifier accepted, counting only rows of the same
 * environment so the benchmark and real traffic never train each other (no environment known: all rows).
 * Null below `minSamples`.
 */
export function getCategorySuccessRate(params: { category: string; window: number; minSamples: number; environment: string | null }): number | null {
  try {
    const rows = getDb().prepare(`
      SELECT json_extract(meta, '$.local_accepted') as accepted
      FROM events
      WHERE layer = 'llm'
        AND json_extract(meta, '$.category') = ?
        AND json_extract(meta, '$.local_attempted') = 1
        AND (? IS NULL OR environment = ?)
      ORDER BY ts DESC
      LIMIT ?
    `).all(params.category, params.environment, params.environment, params.window) as { accepted: 1 | 0 | null | boolean }[];
    if (rows.length < params.minSamples) return null;
    return rows.filter(row => row.accepted === 1 || row.accepted === true).length / rows.length;
  } catch {
    return null; // fail open, as before
  }
}

export interface LocalAttempt {
  /** The answer to send, or null to continue to the cloud. */
  answer: string | null;
  category?: string;
  /** The local model was asked to answer. */
  attempted: boolean;
  /** The verifier accepted the answer. */
  accepted: boolean;
  verifierFlags: string[];
  fromCache: boolean;
  /** The local model that answered ('semcache' for a cache hit). */
  model: string;
}

/**
 * A cache hit is served only when the answer would be eligible now. Entries written here carry their
 * category; plain strings (older entries, and the bench's cached cloud answers) have none, so they are
 * served only when no tools are listed, as before.
 */
export function servableCacheHit(hit: unknown, toolsListed: boolean): string | null {
  if (typeof hit === 'string') return toolsListed ? null : hit;
  const entry = hit as { answer?: unknown; category?: unknown } | null;
  if (typeof entry?.answer !== 'string') return null;
  return !toolsListed || ALLOWED_WITH_TOOLS.includes(String(entry.category)) ? entry.answer : null;
}

/** A local-model client whose every request is cancelled when `signal` aborts (ollama-js takes a custom fetch). */
function localModelClient(signal?: AbortSignal): SLM {
  if (!signal) return new SLM();
  const abortableFetch = ((input: any, init?: any) => fetch(input, { ...init, signal })) as typeof fetch;
  return new SLM(new Ollama({ host: CONFIG.OLLAMA_HOST, fetch: abortableFetch }));
}

/**
 * Asks the local model to answer, when the request is eligible, and checks the answer.
 *
 * @param params.task The typed text the answer is for
 * @param params.messages What the model is given to answer
 * @param params.toolsListed The request offers the model tools (narrows eligibility)
 * @param params.routePolicy 'force-local' answers regardless of eligibility and verification (bench arms)
 * @param params.localModel Answering model; defaults to SLM_BRAIN_MODEL
 * @param params.environment Ledger environment ROUTING_TUNE learns from
 * @param params.signal Aborting it cancels every model call; the attempt then returns no answer and stores nothing
 * @returns What happened; never throws
 */
export async function attemptLocalAnswer(params: {
  task: string;
  messages: { role: string; content: string }[];
  toolsListed: boolean;
  routePolicy?: 'auto' | 'force-local';
  localModel?: string;
  environment?: string | null;
  signal?: AbortSignal;
}): Promise<LocalAttempt> {
  const { task, messages, toolsListed, routePolicy = 'auto', signal } = params;
  const localModel = params.localModel ?? CONFIG.SLM_BRAIN_MODEL;
  const result: LocalAttempt = { answer: null, attempted: false, accepted: false, verifierFlags: [], fromCache: false, model: localModel };

  // Checked before any model call, so a workspace or identity question costs nothing.
  if (routePolicy !== 'force-local' && toolsListed && (mentionsWorkspace(task) || asksAboutAssistant(task))) return result;

  if (CONFIG.SEMCACHE) {
    let hit: unknown = null;
    try {
      // The cache's embedding call cannot take the attempt's signal, so stop waiting for it on abort;
      // otherwise a slow embedding would hold the one-attempt-at-a-time slot past the budget.
      hit = await unlessAborted(checkSemanticCache(task), signal);
    } catch (err) {
      console.error(`[llm-gate] semantic cache lookup failed, treated as a miss: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (signal?.aborted) return result;
    const cached = servableCacheHit(hit, toolsListed);
    if (cached !== null) return { ...result, answer: cached, fromCache: true, model: 'semcache', verifierFlags: ['cache_hit'] };
  }

  const slm = localModelClient(signal);
  let category = 'other';
  try {
    if (task) category = await classify(slm, task);
  } catch {
    // Classification failed: treated as 'other', as before.
  }
  if (signal?.aborted) return result;
  result.category = category;

  let eligible = (toolsListed ? ALLOWED_WITH_TOOLS : ALLOWED).includes(category);
  if (CONFIG.ROUTING_TUNE && eligible && routePolicy !== 'force-local' && Math.random() >= CONFIG.ROUTING_TUNE_EXPLORE_RATE) {
    const rate = getCategorySuccessRate({
      category,
      window: CONFIG.ROUTING_TUNE_WINDOW,
      minSamples: CONFIG.ROUTING_TUNE_MIN_SAMPLES,
      environment: params.environment ?? CONFIG.LANGFUSE_ENVIRONMENT ?? null,
    });
    if (rate !== null && rate < CONFIG.ROUTING_TUNE_THRESHOLD) eligible = false;
  }
  if (routePolicy !== 'force-local' && !eligible) return result;

  result.attempted = true;
  try {
    let samples: string[] = [];
    let answer: string;
    if (CONFIG.HEADLINE_STRICTNESS >= 4) {
      // Self-consistency: several samples must agree (the verifier's level 4).
      samples = await Promise.all(Array.from({ length: CONFIG.SELF_CONSISTENCY_K }, () =>
        slm.generateText(localModel, messages, CONFIG.SELF_CONSISTENCY_TEMP)));
      answer = samples[0];
    } else {
      answer = await slm.generateText(localModel, messages, CONFIG.TEMPERATURE);
    }
    if (signal?.aborted) return result;

    // localAccepted means the VERIFIER accepted the answer (non-empty, no hedging, samples agree) — a
    // proxy for quality, not ground-truth correctness.
    const verdict = verify(answer, samples, { nonEmpty: true }, CONFIG.HEADLINE_STRICTNESS);
    result.verifierFlags = verdict.flags;
    result.accepted = !verdict.escalate;
    if (result.accepted || routePolicy === 'force-local') result.answer = answer;
  } catch (err) {
    if (!signal?.aborted) handleSlmError(err, 'llm-gate:generate', localModel);
  }
  if (result.accepted && result.answer !== null) {
    // Remembering the answer is a bonus: a failure here must not cost the answer itself.
    await setSemanticCache(task, { answer: result.answer, category }).catch(err =>
      console.error(`[llm-gate] semantic cache write failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  return result;
}

/** Resolves like `work`, or with null as soon as `signal` aborts (the work itself keeps running). */
function unlessAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(null);
  return Promise.race([work, new Promise<null>(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }))]);
}

let attemptRunning = false;

/**
 * Step A for the gate: one attempt at a time, cancelled at LOCAL_ATTEMPT_BUDGET_MS. A first request that
 * arrives while another attempt runs goes straight on (it never queues behind the local model).
 *
 * @returns The attempt, or null when it was skipped (busy) or ran out of time
 */
export async function answerFirstRequestLocally(params: { task: string; toolsListed: boolean }): Promise<{ attempt: LocalAttempt | null; outcome: 'answered' | 'declined' | 'busy' | 'timeout' }> {
  if (attemptRunning) return { attempt: null, outcome: 'busy' };
  attemptRunning = true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.LOCAL_ATTEMPT_BUDGET_MS);
  const work = attemptLocalAnswer({
    task: params.task,
    messages: [{ role: 'user', content: params.task }],
    toolsListed: params.toolsListed,
    environment: CONFIG.LANGFUSE_ENVIRONMENT,
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timer);
    attemptRunning = false;
  });
  const expired = new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));

  const attempt = await Promise.race([work, expired]);
  if (!attempt || controller.signal.aborted) return { attempt: null, outcome: 'timeout' };
  return { attempt, outcome: attempt.answer !== null ? 'answered' : 'declined' };
}

/** Loads the answering model in the background so the first eligible request does not pay the cold start. */
export function warmUpAnsweringModel(): void {
  new SLM().generateText(CONFIG.SLM_BRAIN_MODEL, [{ role: 'user', content: 'ok' }], 0, 1).catch(() => {
    // Ollama down or model missing: attempts then fall back to the normal path on their own.
  });
}
