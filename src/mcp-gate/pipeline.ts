import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkSemanticCache, setSemanticCache } from '../cache/index.js';
import { CONFIG } from '../config.js';
import { cacheGet, cacheSet, writeEvent } from '../ledger/index.js';
import { handleSlmError, withSlmTimeout } from '../models/helpers.js';
import { SLM } from '../models/slm.js';
import { resolveAmbiguities } from '../resolver/index.js';
import { distillToolResult } from '../utils/elision.js';
import { scan } from './ground.js';
import { buildPreserveList } from './patterns.js';


let slmClient: ReturnType<typeof createSlmClient>;
/**
 * Creates and initializes a new instance of the Small Language Model (SLM) client.
 * @returns {SLM} A new SLM client instance.
 */
function createSlmClient() {
  return new SLM();
}

let cachedPreserveList: RegExp[] | null = null;
/**
 * Retrieves the compiled list of regular expressions used to identify text blocks 
 * that must be preserved verbatim during the distillation process. Results are cached.
 * @returns {Promise<RegExp[]>} A promise resolving to an array of preservation regular expressions.
 */
async function getPreserveList(): Promise<RegExp[]> {
  if (!cachedPreserveList) {
    cachedPreserveList = await buildPreserveList();
  }
  return cachedPreserveList;
}


/** Which class of failure an SLM stage hit; null means it succeeded. */
type SlmErrorKind = 'timeout' | 'format' | 'transport' | 'unknown' | null;

const SLM_ERROR_NOTES: Record<NonNullable<SlmErrorKind>, string> = {
  timeout: 'The local model exceeded SLM_TIMEOUT_MS. Raise the budget or use a smaller model.',
  format: 'The local model returned output that could not be parsed. Try a larger or more instruction-following model.',
  transport: 'The local model could not be reached. Check that Ollama is running at OLLAMA_HOST.',
  unknown: 'The local model failed for an unrecognised reason. See stderr for details.',
};

/**
 * Classifies an SLM failure so the cause is actionable.
 *
 * @param err The thrown error
 * @returns The error class, never null (callers use null to mean "no error").
 */
function classifySlmError(err: unknown): NonNullable<SlmErrorKind> {
  const name = (err as { name?: string })?.name ?? '';
  const message = ((err as { message?: string })?.message ?? '').toLowerCase();
  if (name === 'SlmTimeoutError' || message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (name === 'SlmFormatError' || message.includes('json') || message.includes('parse')) return 'format';
  if (message.includes('fetch failed') || message.includes('econnrefused') || message.includes('econnreset')) return 'transport';
  return 'unknown';
}

/**
 * Writes a single `condition` ledger event.
 *
 * Centralised so the cache-hit path, the semantic-cache path and the full pipeline all
 * report identically — previously only the slow path emitted anything at all.
 *
 * @param params.text Raw inbound tool output
 * @param params.conditioned Text actually returned to the host
 * @param params.args Tool arguments, carrying host-supplied model/agent/session hints
 * @param params.startTime Epoch ms when conditioning began
 * @param params.cacheHit Which cache served this request, if any
 * @param params.errorKinds Per-stage failure classes, for diagnosis
 */
function emitConditionEvent(params: {
  text: string;
  conditioned: string;
  args?: any;
  startTime: number;
  cacheHit?: 'exact' | 'semantic';
  errorKinds?: { distill: SlmErrorKind; resolver: SlmErrorKind };
}): void {
  const { text, conditioned, args, startTime, cacheHit, errorKinds } = params;
  const meta: Record<string, unknown> = {};
  if (cacheHit) meta.cache_hit = cacheHit;
  if (errorKinds?.distill) meta.distill_error = errorKinds.distill;
  if (errorKinds?.resolver) meta.resolver_error = errorKinds.resolver;

  writeEvent({
    ts: new Date().toISOString(),
    layer: 'mcp',
    // randomUUID, not Date.now()+short random: the old id could collide within the same
    // millisecond, and INSERT OR REPLACE on the request_id PK then silently dropped a row.
    request_id: `cond_${crypto.randomUUID()}`,
    session_id: args?.sessionId ? String(args.sessionId) : (args?.session_id ? String(args.session_id) : undefined),
    skill: args?.skillName ? String(args.skillName) : undefined,
    route: 'condition',
    is_local_call: 1,
    slm_model: CONFIG.SLM_GATE_MODEL,
    api_model: args?.model ? String(args.model) : undefined,
    agent: args?.agent ? String(args.agent) : undefined,
    in_tok: Math.round(text.length / 4),
    out_tok: Math.round(conditioned.length / 4),
    api_in_tok: 0,
    api_out_tok: 0,
    cost_usd: 0,
    // A cache hit does no SLM work; charging it the wall-clock time would inflate latency stats.
    slm_latency_s: cacheHit ? 0 : (Date.now() - startTime) / 1000,
    api_latency_s: 0,
    slm_gate: 'on',
    meta: Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined,
  });
}

/**
 * The main entry point for the MCP gate pipeline. Processes an incoming prompt by checking the cache, 
 * optionally distilling (compressing) the text, grounding it with workspace context, and resolving 
 * ambiguities using a small language model. 
 * 
 * @param {string} text - The raw skill/prompt text received from the client.
 * @param {string} task - A description of the current task for context during distillation and resolution.
 * @param {string} [rootUri] - Optional URI of the workspace root to enable grounding and file context extraction.
 * @returns {Promise<string>} The conditioned and enriched prompt ready for the cloud model.
 */
export async function conditionPrompt(text: string, task: string, rootUri?: string, toolName?: string, args?: any): Promise<string> {
  const startTime = Date.now();
  
  if (!slmClient) {
    slmClient = createSlmClient();
    console.error(`[pipeline] Initialized SLM with OLLAMA_HOST=${CONFIG.OLLAMA_HOST}`);
  }

  // 1. Cache Check
  // PROMPT_VERSION participates in the key. It is documented in .env.example as the lever to
  // bump when prompt logic changes.
  const hash = crypto.createHash('sha256')
    .update(text + '||' + task + '||' + (rootUri || '') + '||' + (toolName || '') + '||' + CONFIG.PROMPT_VERSION)
    .digest('hex');
  const cacheKey = `condition_${hash}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    // A cache hit is the BEST outcome — full compression at zero SLM compute — yet it used
    // to return before any writeEvent, making it invisible to every metric and biasing all
    // savings figures toward the slow path.
    emitConditionEvent({ text, conditioned: cached, args, startTime, cacheHit: 'exact' });
    return cached;
  }
  
  if (CONFIG.SEMCACHE) {
    const semCached = await checkSemanticCache(text);
    if (semCached && typeof semCached === 'string') {
      emitConditionEvent({ text, conditioned: semCached, args, startTime, cacheHit: 'semantic' });
      return semCached;
    }
  }

  const preserveList = await getPreserveList();

  // 2. Distill
  // Compresses ONE narrative run. distillToolResult never sends protected content here, so this
  // prompt carries no placeholder-custody rules — a 3B model reliably summarises prose and
  // reliably loses opaque tokens. An explicit word budget is what actually drives the
  // ratio: without it the model rewords instead of condensing (measured 4-8% vs 44-60%).
  const slmFunc = async (t: string, taskDesc?: string) => {
    const wordCount = t.trim().split(/\s+/).length;
    const targetWords = Math.max(20, Math.ceil(wordCount * 0.35));
    const prompt = `Compress the text below to AT MOST ${targetWords} words.\n\nKeep: every instruction, requirement, constraint, name, number, path and technical specific.\nDelete: background, history, rationale, motivation, repetition and filler.\nOutput ONLY the compressed text as terse bullet points. No preamble, no heading.\n\nTask context: ${taskDesc || 'None'}\n\n${t}`;
    // This was the only model call in the pipeline with neither a token ceiling nor a timeout.
    // Ollama sends HTTP response headers only AFTER generation completes, so the effective cap
    // is Node fetch's 300s header timeout surfacing as `fetch failed`, misclassified as a
    // transport error, long after the MCP client had given up. SLM_TIMEOUT_MS now governs it.
    // The ceiling is per-run and generous against the target so a summary is never cut mid-
    // sentence; the run is discarded anyway if it comes back longer than the original.
    return withSlmTimeout(
      slmClient.generateText(
        CONFIG.SLM_GATE_MODEL,
        [{ role: 'user', content: prompt }],
        CONFIG.TEMPERATURE,
        Math.max(128, Math.ceil(wordCount * 0.6))
      ),
      'distill',
      CONFIG.SLM_TIMEOUT_MS
    );
  };
  
  const startDistill = Date.now();
  let conditioned = text;
  let distillErrorKind: SlmErrorKind = null;
  try {
    conditioned = await distillToolResult(slmFunc, text, task, toolName, args, preserveList);
  } catch (err: any) {
    handleSlmError(err, 'pipeline:distill', CONFIG.SLM_GATE_MODEL);
    distillErrorKind = classifySlmError(err);
    conditioned = text;
  }
  console.error(`[pipeline] distill ${((Date.now() - startDistill) / 1000).toFixed(1)}s`);

  // 3. Ground
  let groundCtx = '';
  if (rootUri) {
    groundCtx = await scan(rootUri);
  }

  // 4. Clarify (Resolver)
  let fsReadFn = async (pattern: string) => [] as string[];
  if (rootUri) {
    let rootPath = rootUri;
    if (rootUri.startsWith('file://')) {
       try { rootPath = fileURLToPath(rootUri); } catch { rootPath = rootUri.substring(7); }
    }
    fsReadFn = async (pattern: string) => {
      try {
        const content = await fs.readFile(path.join(rootPath, pattern), 'utf-8');
        // Single `\n`: splitting on the two characters backslash-n never matched, so the whole
        // file arrived as ONE element and the 50-line cap silently did nothing.
        return content.split('\n').slice(0, 50);
      } catch {
        return [];
      }
    };
  }

  const startResolver = Date.now();
  let resolveOut = { autoApplied: [] as any[], askUser: [] as any[] };
  let resolverErrorKind: SlmErrorKind = null;
  try {
    resolveOut = await resolveAmbiguities(slmClient, fsReadFn, {
      skillText: text,
      task,
      repoRoot: rootUri ? (rootUri.startsWith('file://') ? fileURLToPath(rootUri) : rootUri) : undefined
    });
  } catch (err: any) {
    handleSlmError(err, 'pipeline:resolver', CONFIG.SLM_BRAIN_MODEL);
    resolverErrorKind = classifySlmError(err);
  }
  console.error(`[pipeline] resolver ${((Date.now() - startResolver) / 1000).toFixed(1)}s`);

  // Append findings to the conditioned output.
  // NOTE: single `\n` inside these template literals. `\\n` emits the two characters backslash-n,
  // so every appended section used to arrive at the cloud model as one unbroken line littered
  // with literal "\n" — markdown the model then had to read through.
  if (groundCtx) {
    conditioned += `\n\n# Environment Context\n${groundCtx}`;
  }

  if (resolveOut.autoApplied.length > 0) {
    conditioned += `\n\n# Auto-Resolved Decisions\n`;
    for (const res of resolveOut.autoApplied) {
      conditioned += `- **${res.question}**: ${res.answer}\n`;
    }
  }

  if (resolveOut.askUser.length > 0) {
    conditioned += `\n\n# Pending Clarifications (Ask User)\n`;
    for (const ask of resolveOut.askUser) {
      conditioned += `- **${ask.question}** (Recommendation: ${ask.recommendedAnswer || 'None'})\n`;
    }
  }
  
  // Report the ACTUAL failure. Both stages previously reported "timed out" for every error
  // class, so a model that simply could not produce valid JSON was indistinguishable from a
  // genuine timeout — the difference between raising SLM_TIMEOUT_MS and changing the model.
  if (distillErrorKind) {
    conditioned += `\n\n# Note\n[distill_${distillErrorKind}] ${SLM_ERROR_NOTES[distillErrorKind]}`;
  }
  if (resolverErrorKind) {
    conditioned += `\n\n# Note\n[resolver_${resolverErrorKind}] ${SLM_ERROR_NOTES[resolverErrorKind]}`;
  }

  // 5. Ledger
  emitConditionEvent({
    text,
    conditioned,
    args,
    startTime,
    errorKinds: { distill: distillErrorKind, resolver: resolverErrorKind }
  });

  // 6. Cache Set.
  //
  // Previously this required BOTH stages to succeed. The resolver fails on essentially
  // every call in practice, so the cache was never written and every identical tool call
  // re-ran the full distil + resolve pipeline from scratch. Distillation is the expensive,
  // valuable half and its result is correct on its own, so a resolver failure alone no
  // longer blocks caching.
  if (!distillErrorKind) {
    cacheSet(cacheKey, conditioned);
    if (CONFIG.SEMCACHE) {
      await setSemanticCache(text, conditioned);
    }
  }

  return conditioned;
}
