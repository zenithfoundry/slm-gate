import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkSemanticCache, setSemanticCache } from '../cache/index.js';
import { CONFIG } from '../config.js';
import { cacheDepsFresh, cacheGet, cacheSet, matchMemory, readMemoryRow, writeCacheDeps, writeEvent } from '../ledger/index.js';
import { parseSummary, renderSummary } from '../llm-gate/memory.js';
import { handleSlmError } from '../models/helpers.js';
import { checkKept, compressNarrativeRun } from '../models/reasoning.js';
import { SLM } from '../models/slm.js';
import { prepareSkillContext, resolveAmbiguities } from '../resolver/index.js';
import type { ResolverOutput } from '../resolver/types.js';
import { existingCodeSection, refreshRepoIndex } from '../index/repo-index.js';
import { repoIndexRevision } from '../ledger/index.js';

/** The repo root as a path, from the editor's root URI. */
function rootPathOf(rootUri: string): string {
  if (!rootUri.startsWith('file://')) return rootUri;
  try { return fileURLToPath(rootUri); } catch { return rootUri.substring(7); }
}

/**
 * The "Existing code that may already cover this" section, from the repository index: computed on every call from the current
 * index, hit or miss, and never cached — a code edit therefore never invalidates a cached conditioning by
 * itself. Empty when REPO_INDEX is off, there is no root, or nothing matches.
 */
function existingCodeFor(params: { rootUri?: string; task: string }): string {
  if (!CONFIG.REPO_INDEX || !params.rootUri) return '';
  try {
    const root = rootPathOf(params.rootUri);
    refreshRepoIndex(root);
    return existingCodeSection({ root, task: params.task });
  } catch (err) {
    console.error(`[pipeline] repo index skipped: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

/** Resolves the `index:<root>` pseudo-dependency (the repository index revision) from the ledger; real paths fall through to a stat. */
/** Resolves pseudo-path dependencies (`index:<root>`, `memory:<key>`) from the ledger; real paths fall through to a stat. */
const depValue = (depPath: string): number | null | undefined => {
  if (depPath.startsWith('index:')) return repoIndexRevision(depPath.slice('index:'.length));
  // `memory:<key>` is the conversation memory's fold time (ms): a newer fold makes the conditioning a miss.
  if (depPath.startsWith('memory:')) { const row = readMemoryRow(depPath.slice('memory:'.length)); return row ? new Date(row.folded_at).getTime() : null; }
  return undefined;
};

// When this MCP session started: a conversation memory qualifies only if its conversation began at or after.
const MCP_SESSION_STARTED_AT = new Date().toISOString();

/** The usable conversation memory for this workspace, rendered, or nothing (conversation memory). */
function conversationFor(rootUri?: string): { text: string | null; decided: string[]; row: ReturnType<typeof matchMemory>['row']; match: ReturnType<typeof matchMemory>['match'] } {
  if (!CONFIG.CONVERSATION_MEMORY || !rootUri) return { text: null, decided: [], row: null, match: 'none' };
  const found = matchMemory({ root: rootPathOf(rootUri), startedAfter: MCP_SESSION_STARTED_AT });
  const parsed = found.row ? parseSummary(found.row.summary) : null;
  if (!found.row || !parsed) return { text: null, decided: [], row: null, match: 'none' };
  return { text: renderSummary(parsed), decided: parsed.decided, row: found.row, match: found.match };
}
import { distillToolResultWithStats, FidelityStats, FidelityVerify } from '../utils/elision.js';
import { scan } from './ground.js';
import { buildPreserveList } from '../utils/preserve-patterns.js';


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
  /** What the resolver was given and found; absent on cache hits (no resolver work). */
  resolver?: { context_tok_est: number; skill_tok_est: number; trimmed: 0 | 1; questions: number; stale_decisions: string[] };
  /** What the fidelity guard measured; `{ mode: 'cache_hit' }` on hits (no measurement), null after a distil error. */
  fidelity?: FidelityStats | { mode: 'cache_hit' } | null;
  /** Which conversation memory the resolver read, if any (never the text). */
  memory?: { match: 'key' | 'root-recent' | 'none' };
}): void {
  const { text, conditioned, args, startTime, cacheHit, errorKinds, resolver, fidelity, memory } = params;
  const meta: Record<string, unknown> = {};
  if (cacheHit) meta.cache_hit = cacheHit;
  if (fidelity) meta.fidelity = fidelity;
  if (memory) meta.memory = memory;
  if (errorKinds?.distill) meta.distill_error = errorKinds.distill;
  if (errorKinds?.resolver) meta.resolver_error = errorKinds.resolver;
  if (resolver) meta.resolver = resolver;

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
  // Conversation memory: the usable summary for this workspace joins the key (`m<folded_at>` or `nomem`), so
  // an entry cached without memory misses once memory exists, and a newer fold gives a fresh conditioning.
  const conversation = conversationFor(rootUri);
  const memoryPart = conversation.row ? `m${conversation.row.folded_at}` : 'nomem';
  const hash = crypto.createHash('sha256')
    .update(text + '||' + task + '||' + (rootUri || '') + '||' + (toolName || '') + '||' + CONFIG.PROMPT_VERSION + '||' + memoryPart)
    .digest('hex');
  const cacheKey = `condition_${hash}`;
  // A hit is served only while the repository state it relied on (decision files and the symbol index) is unchanged; rows without dependencies are served as before. The index is brought up to date
  // first — forced past its debounce, because this compare must see the revision AFTER any code edit; the
  // section appended later reuses the fresh index through the debounced path.
  if (CONFIG.REPO_INDEX && rootUri) {
    try { refreshRepoIndex(rootPathOf(rootUri), { force: true }); } catch (err) { console.error(`[pipeline] repo index refresh skipped: ${err instanceof Error ? err.message : String(err)}`); }
  }
  const cached = cacheDepsFresh(cacheKey, { statMtime: depValue }) ? cacheGet(cacheKey) : null;
  if (cached) {
    // A cache hit is the BEST outcome — full compression at zero SLM compute — yet it used
    // to return before any writeEvent, making it invisible to every metric and biasing all
    // savings figures toward the slow path.
    emitConditionEvent({ text, conditioned: cached, args, startTime, cacheHit: 'exact', fidelity: { mode: 'cache_hit' }, memory: { match: conversation.match } });
    return cached + existingCodeFor({ rootUri, task });
  }
  
  // A semantic hit returns before the resolver runs and cannot carry a memory dependency, so it is skipped
  // whenever a usable conversation memory exists.
  if (CONFIG.SEMCACHE && !conversation.row) {
    const semCached = await checkSemanticCache(text);
    if (semCached && typeof semCached === 'string') {
      emitConditionEvent({ text, conditioned: semCached, args, startTime, cacheHit: 'semantic', fidelity: { mode: 'cache_hit' } });
      return semCached + existingCodeFor({ rootUri, task });
    }
  }

  const preserveList = await getPreserveList();

  // 2. Distill (the compressor is shared with the model gate; see compressNarrativeRun). The brain model
  // checks every shortened prose run against the requirement sentences the code listed: the skill fidelity guard.
  const slmFunc = (t: string, taskDesc?: string) => compressNarrativeRun({ slm: slmClient, text: t, task: taskDesc });
  const verify: FidelityVerify = ({ inventory, compressed }) => checkKept({ slm: slmClient, inventory, compressed });

  const startDistill = Date.now();
  let conditioned = text;
  let distillErrorKind: SlmErrorKind = null;
  let fidelity: FidelityStats | null = null;
  try {
    ({ text: conditioned, fidelity } = await distillToolResultWithStats({ slm: slmFunc, text, task, toolName, args, preservePatterns: preserveList, verify }));
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
  let resolveOut: ResolverOutput = { autoApplied: [], askUser: [] };
  let resolverErrorKind: SlmErrorKind = null;
  // Slice 4: the resolver's prompt must fit the local context; a whole skill often does not.
  const skillContext = prepareSkillContext(text, CONFIG.RESOLVER_PROMPT_TOKENS);
  try {
    resolveOut = await resolveAmbiguities(slmClient, fsReadFn, {
      skillText: skillContext.text,
      task,
      conversation: conversation.text,
      decided: conversation.decided,
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

  // Provenance of a decision-file answer: an answer from a decision file says so, with who verified it and when.
  if (resolveOut.autoApplied.length > 0) {
    conditioned += `\n\n# Auto-Resolved Decisions\n`;
    for (const res of resolveOut.autoApplied) {
      conditioned += `- **${res.question}**: ${res.answer}${res.provenance ? ` (${res.provenance})` : ''}\n`;
    }
  }

  if (resolveOut.askUser.length > 0) {
    conditioned += `\n\n# Pending Clarifications (Ask User)\n`;
    for (const ask of resolveOut.askUser) {
      conditioned += `- **${ask.question}** (Recommendation: ${ask.recommendedAnswer || 'None'}${ask.provenance ? `; ${ask.provenance}` : ''})\n`;
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
    errorKinds: { distill: distillErrorKind, resolver: resolverErrorKind },
    fidelity,
    resolver: {
      // What the resolver was given (after trimming), beside the skill's full size.
      context_tok_est: skillContext.tokEst,
      skill_tok_est: skillContext.originalTokEst,
      trimmed: skillContext.trimmed ? 1 : 0,
      questions: resolveOut.autoApplied.length + resolveOut.askUser.length,
      stale_decisions: resolveOut.staleDecisions ?? [],
    },
    memory: { match: conversation.match },
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
    // The repository state this result relied on (decision files, the symbol index); a change makes the next call a miss.
    writeCacheDeps(cacheKey, [
      ...(resolveOut.dependencies ?? []),
      // The conversation memory this result read: a newer fold recomputes it (depValue resolves `memory:`).
      ...(conversation.row ? [{ path: `memory:${conversation.row.key}`, mtime: new Date(conversation.row.folded_at).getTime(), expiresAt: null }] : []),
    ]);
    if (CONFIG.SEMCACHE) {
      await setSemanticCache(text, conditioned);
    }
  }

  // Appended after caching on purpose: the section follows the index, not the cache.
  return conditioned + existingCodeFor({ rootUri, task });
}
