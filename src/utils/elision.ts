/**
 * Elision and distillation of tool results: which lines to keep, which to cut behind an expand_elision
 * marker, the elision id those markers carry, and the fidelity guard that keeps a shortened skill honest.
 * Both gates run tool results through here.
 */
import MarkdownIt from 'markdown-it';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { getDb, getDistillFeedback, getDistillPolicy, learnedProtections, normaliseProtection, recordLostSentences, writeElision } from '../ledger/index.js';
import { log } from '../log.js';
import { bufferToFloat64Array, cosineSimilarity, embedText } from '../utils/embedding.js';
import { TOOL_RESULT_PREFIXES } from './constants.js';

// NOTE:: "Elision" meaning is; Leaving out a sound, a syllable, or a word part when speaking.

/**
 * Narrative runs shorter than this are left verbatim during summarize-mode compression.
 * A model round-trip on a line or two costs more wall-clock time than the tokens it saves.
 */
const MIN_COMPRESSIBLE_SEGMENT_CHARS = 400;

/**
 * How many narrative runs are in flight at the model at once.
 *
 * Ollama executes at most OLLAMA_NUM_PARALLEL requests (1 on most hosts) and queues the rest,
 * while the per-call timeout is a Promise.race that cannot cancel the queued generation. Firing
 * every run at once therefore made late runs burn their whole SLM_TIMEOUT_MS waiting in Ollama's
 * queue, time out having never run, and then keep occupying the GPU after the caller had given
 * up — starving the runs still queued behind them. A run is now handed to the model only when a
 * slot frees up, so its timer starts when its generation can actually start.
 */
// Prose runs shortened at the same time; a setting since the gate-model bench so the bench can compare 1 and 2.
const MAX_CONCURRENT_SEGMENT_CALLS = Math.max(1, CONFIG.MAX_CONCURRENT_SEGMENT_CALLS ?? 2);

/**
 * Computes a deterministic SHA-256 ID for a tool elision.
 * By hashing the tool name, arguments, and original content, we ensure that
 * identical tool outputs always produce the exact same elision ID,
 * enabling safe and highly-cacheable reconstruction logic.
 *
 * @param params.toolName - The name of the tool (e.g., 'read_file')
 * @param params.args - The structured arguments provided to the tool
 * @param params.originalText - The complete, uncompressed raw text returned by the tool
 * @returns A unique hexadecimal SHA-256 hash identifying this exact output state
 */
export function computeElisionId(params: { toolName: string; args: any; originalText: string }): string {
  const { toolName, args, originalText } = params;
  const hashText = crypto.createHash('sha256').update(originalText).digest('hex');
  const payload = `${toolName}:${JSON.stringify(args || {})}:${hashText}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Formats a clear, identifiable text marker indicating that lines were elided.
 * This marker informs downstream LLMs that content is missing and provides the `expand_elision`
 * ID they can use if they determine they actually need the omitted lines.
 *
 * @param params.elisionId - The unique SHA-256 hash for the original content
 * @param params.elidedLinesCount - Number of lines that were removed
 * @param params.startLine - Optional starting line index of the removed chunk
 * @param params.endLine - Optional ending line index of the removed chunk
 * @returns A formatted string marker designed for robust parsing
 */
export function formatElisionMarker(params: { elisionId: string; elidedLinesCount: number; startLine?: number; endLine?: number }): string {
  const { elisionId, elidedLinesCount, startLine, endLine } = params;
  const hasRange = startLine !== undefined && endLine !== undefined;
  const rangeStr = hasRange ? `, lines ${startLine}-${endLine}` : '';
  // Spell out the range argument: without it, expand_elision starts from the top of the
  // original, which looks like the same cut text coming back.
  // ask_elision: a question costs a few sentences instead of a 2,000-token page.
  const how = hasRange
    ? `call expand_elision with this id and range {"startLine": ${startLine}, "endLine": ${endLine}} to retrieve, or ask_elision with this id and a question`
    : 'call expand_elision with this id to retrieve, or ask_elision with this id and a question';
  return `\n... ${elidedLinesCount} lines elided [id: ${elisionId}${rangeStr}] — ${how} ...\n`;
}

/**
 * Splits a document into chunks that each fit `maxTokens`, cutting at headings where it can and at the budget
 * where it must, with the line range of each chunk so an answer can point back at the original. Pure.
 */
export function splitByHeadings(text: string, maxTokens: number): { text: string; startLine: number; endLine: number }[] {
  const lines = text.split('\n');
  const chunks: { text: string; startLine: number; endLine: number }[] = [];
  let start = 0;
  let tokens = 0;
  const flush = (end: number) => {
    if (end <= start) return;
    chunks.push({ text: lines.slice(start, end).join('\n'), startLine: start, endLine: end - 1 });
    start = end;
    tokens = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const cost = estimateTokens(lines[i]) + 1;
    const isHeading = /^#{1,6}\s/.test(lines[i]);
    if (tokens > 0 && (isHeading && tokens + cost > maxTokens * 0.6 || tokens + cost > maxTokens)) flush(i);
    tokens += cost;
  }
  flush(lines.length);
  return chunks;
}

// Matches the retrieval clause formatElisionMarker writes, with or without a range. Kept next to it so
// a wording change is made in both places; a test pairs them.
const EXPAND_HINT = /— call expand_elision with this id(?: and range \{"startLine": \d+, "endLine": \d+\})? to retrieve, or ask_elision with this id and a question \.\.\./g;

/**
 * Rewrites the markers in a distilled text for a client that has no `expand_elision` tool (the MCP
 * layer is optional): the marker still says how many lines are missing, but points the model at
 * re-running its own tool instead of a tool it cannot call.
 *
 * @param text Distilled text containing markers from formatElisionMarker
 * @returns The same text with every retrieval clause replaced
 */
export function rewriteElisionHint(text: string): string {
  return text.replace(EXPAND_HINT, '— not shown by slm-gate; re-run the tool with a narrower scope to see them ...');
}

/**
 * Takes as many lines from a range as fit in a token budget, never skipping any.
 *
 * @param params.lines All lines of the original text
 * @param params.startLine First line wanted (inclusive)
 * @param params.endLine Last line wanted (inclusive)
 * @param params.maxTokens Budget for this page
 * @returns The page text, and the first line not yet returned (undefined when done)
 */
export function pageLines(params: {
  lines: readonly string[];
  startLine: number;
  endLine: number;
  maxTokens: number;
}): { text: string; nextStart?: number } {
  const { lines, startLine, endLine, maxTokens } = params;
  const page: string[] = [];
  let tokens = 0;
  let i = startLine;
  for (; i <= endLine; i++) {
    const lineTokens = estimateTokens(lines[i] + '\n');
    // Always return at least one line, so paging can never stall.
    if (page.length > 0 && tokens + lineTokens > maxTokens) break;
    page.push(lines[i]);
    tokens += lineTokens;
  }
  return { text: page.join('\n'), nextStart: i <= endLine ? i : undefined };
}

/**
 * The one character-to-token ratio every estimate in the gate uses (ledger rows, budgets, tool-definition
 * sizes). A rough figure for mixed prose and code; one value so two estimates of the same text never disagree.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimates the number of tokens in a string based on a rough character-to-token heuristic.
 * Used for fast, zero-dependency short-circuiting before invoking the actual SLM.
 *
 * @param text - The text to evaluate
 * @returns Estimated token count (roughly 1 token per CHARS_PER_TOKEN characters)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Result structure returned when parsing raw context to deduce tool provenance.
 */
export interface ExtractResult {
  /** The identified name of the tool, if any */
  toolName?: string;
  /** Parsed JSON arguments of the tool call, if any */
  args?: any;
  /** A heuristically extracted file path, if the tool seems to target a file */
  filePath?: string;
}

/**
 * Attempts to parse raw tool-result context to deduce the tool name, arguments, and target file.
 * Many MCP clients just dump raw text; this heuristic extractor tries to glean structure
 * by matching common JSON wrappers, path structures, and standard prefixes.
 *
 * @param content - The raw context string to analyze
 * @returns An `ExtractResult` containing any successfully deduced tool metadata
 */
export function extractToolSignature(content: string): ExtractResult {
  let toolName: string | undefined;
  let args: any;
  let filePath: string | undefined;

  // Try to parse JSON blocks that might represent tool calls
  try {
    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.name || parsed.tool) toolName = parsed.name || parsed.tool;
      if (parsed.arguments || parsed.args) args = parsed.arguments || parsed.args;
      if (args && args.path) filePath = args.path;
      if (args && args.file) filePath = args.file;
      if (args && args.AbsolutePath) filePath = args.AbsolutePath;
      if (args && args.TargetFile) filePath = args.TargetFile;
    }
  } catch (e) {}

  // Fallback regex for common file path mentions
  if (!filePath) {
    const pathMatch = content.match(/(?:\/|\\|^[a-zA-Z]:\\)(?:[^\s"'<>|]+)+/);
    if (pathMatch) filePath = pathMatch[0];
  }

  // Fallback for tool name if it starts with something like "Tool output: read_file"
  if (!toolName) {
    for (const prefix of TOOL_RESULT_PREFIXES) {
      if (content.includes(prefix)) {
        const parts = content.split(prefix);
        if (parts.length > 1) {
          const words = parts[1].trim().split(/[\s:()]+/);
          if (words.length > 0 && words[0].length > 0) {
            toolName = words[0];
          }
        }
      }
    }
  }

  return { toolName, args, filePath };
}

/**
 * Analyzes file contents line-by-line to identify critical structural lines
 * (e.g., imports, function signatures) and lines conceptually related to the user's task.
 * 
 * Used during deterministic distillation of `read_file` operations to safely truncate
 * unneeded implementation details while preserving the file's "skeleton".
 *
 * @param params.lines - Array of lines comprising the file
 * @param params.task - The active user task string, used to derive search terms
 * @param params.searchTerms - Explicit additional search terms to match
 * @returns A sorted array of 0-indexed line numbers that should be preserved
 */
export function findRelevantRegions(params: { lines: string[]; task: string; searchTerms?: string[] }): number[] {
  const { lines, task, searchTerms = [] } = params;
  const keepLines = new Set<number>();
  
  // Create lowercase search terms from task
  const terms = new Set(searchTerms.map(t => t.toLowerCase()));
  if (task) {
    task.split(/\W+/).filter(w => w.length > 3).forEach(w => terms.add(w.toLowerCase()));
  }

  lines.forEach((line, i) => {
    const lowerLine = line.toLowerCase();
    
    // 1. Keep skeleton: imports, exports, class/function signatures
    if (/^(?:import|export|class|function|interface|type)\s/.test(line)) {
      keepLines.add(i);
      return;
    }

    // 2. Keep lines matching task terms
    for (const term of terms) {
      if (lowerLine.includes(term)) {
        // Keep a window around the match
        for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
          keepLines.add(j);
        }
        break;
      }
    }
  });

  return Array.from(keepLines).sort((a, b) => a - b);
}

/**
 * Condenses a sparse array of kept line indices into contiguous block objects.
 * Joins line ranges that are separated by small gaps to prevent fragmented, 
 * unreadable output with too many elision markers.
 *
 * @param lines - The complete original array of lines
 * @param keepLines - Sorted array of line indices to preserve
 * @returns Array of segmented block objects containing the text and boundary indices
 */
export function mergeRegions(lines: string[], keepLines: number[]): { lines: string[], start: number, end: number }[] {
  if (keepLines.length === 0) return [];

  const segments: { lines: string[], start: number, end: number }[] = [];
  let currentStart = keepLines[0];
  let currentEnd = keepLines[0];

  for (let i = 1; i < keepLines.length; i++) {
    if (keepLines[i] <= currentEnd + 2) { // merge if gap <= 2
      currentEnd = keepLines[i];
    } else {
      segments.push({
        lines: lines.slice(currentStart, currentEnd + 1),
        start: currentStart,
        end: currentEnd
      });
      currentStart = keepLines[i];
      currentEnd = keepLines[i];
    }
  }
  
  segments.push({
    lines: lines.slice(currentStart, currentEnd + 1),
    start: currentStart,
    end: currentEnd
  });

  return segments;
}

/** What the fidelity guard measured for one distillation (ledger meta.fidelity, the dashboard card, the bench). */
export interface FidelityStats {
  /** small: under DISTILL_MIN_TOKENS; not_shrunk: a skill still over budget after shrinking, sent as the original. */
  mode: 'small' | 'cache_hit' | 'verbatim' | 'structural' | 'summarize' | 'not_shrunk';
  /** 1 when every protected block and every tracked token survived reassembly (or nothing was compressed). */
  deterministic: 1 | 0;
  /** Average recall over the runs the brain checked; null when none was checked. */
  recall: number | null;
  /** Requirement sentences or tokens that would have been lost (the run was kept verbatim instead). */
  lost: string[];
  /** Prose runs sent to the gate model. */
  runs: number;
  runsChecked: number;
  /** Runs kept verbatim after a failed or impossible check. */
  runsKept: number;
  /** Runs left verbatim because the run cap or the time budget was reached. */
  runsSkippedBudget: number;
  /** Local-model failures (compression or check) that kept a run verbatim; each message says which. */
  errors: string[];
  /** Lines protected because they contain a sentence the brain once reported missing: the learned protections. */
  learnedProtected: number;
  /** Sentences stored as new learned protections by this distillation. */
  learnedNew: number;
  elapsedMs: number;
}

/** Answers, per inventory sentence, whether the compressed text still states it (the brain model, see reasoning.ts). */
export type FidelityVerify = (params: { inventory: string[]; compressed: string }) => Promise<boolean[]>;

const MAX_INVENTORY = 40;
const REQUIREMENT_WORDS = /\b(?:must|should|never|always|do not|don't|only|before|after|unless|required|forbidden)\b/i;
const PATH_LIKE = /(?:^|\s)\.?\/?[\w.-]+\/[\w./-]+/;
const TRACKED_TOKENS = [/\bmcp__\w+/g, /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|min|mins|h|hours?|%|KB|MB|GB|tokens?|lines?|chars?|turns?)\b/g];

/** Fresh stats for a distillation that has done no model work yet (or never will, for the given mode). */
function blankFidelity(mode: FidelityStats['mode']): FidelityStats {
  return { mode, deterministic: 1, recall: null, lost: [], runs: 0, runsChecked: 0, runsKept: 0, runsSkippedBudget: 0, errors: [], learnedProtected: 0, learnedNew: 0, elapsedMs: 0 };
}

/**
 * The sentences of a prose run that carry a requirement: a rule word, a number, a backticked token or a path.
 * Built by code, in order, so the model that checks them cannot leave one out. Pure.
 */
export function requirementInventory(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (sentence.length < 12 || seen.has(sentence)) continue;
    if (REQUIREMENT_WORDS.test(sentence) || /\d/.test(sentence) || sentence.includes('`') || PATH_LIKE.test(sentence)) {
      seen.add(sentence);
      out.push(sentence);
    }
  }
  return out;
}

/** Tool names and unit quantities that must appear verbatim in any rebuilt text. Pure. */
export function fidelityTokens(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of TRACKED_TOKENS) for (const match of text.matchAll(pattern)) found.add(match[0]);
  return [...found];
}

/** `distillToolResultWithStats` for callers that only want the text. */
export async function distillToolResult(params: {
  slm: (text: string, task?: string) => Promise<string>;
  text: string;
  task: string | undefined;
  toolName: string | undefined;
  args: any;
  preservePatterns: RegExp[];
}): Promise<string> {
  return (await distillToolResultWithStats(params)).text;
}

/**
 * Distils one tool result and says what the fidelity guard saw. `verify` turns on the brain check of every
 * compressed prose run (skills); without it the deterministic checks alone apply, as before.
 */
export async function distillToolResultWithStats(params: {
  slm: (text: string, task?: string) => Promise<string>;
  text: string;
  task: string | undefined;
  toolName: string | undefined;
  args: any;
  preservePatterns: RegExp[];
  verify?: FidelityVerify;
}): Promise<{ text: string; fidelity: FidelityStats }> {
  const { slm, text, task, toolName, args, preservePatterns, verify } = params;
  const minTokens = CONFIG.DISTILL_MIN_TOKENS ?? 500;
  const maxTokens = CONFIG.DISTILL_MAX_TOKENS ?? 2000;
  const originalTokens = estimateTokens(text);

  // If small enough, bypass all logic
  if (originalTokens < minTokens) {
    return { text, fidelity: blankFidelity('small') };
  }

  // Determine caching keys
  // Was a hardcoded 'v1', so a distilled result could never be invalidated at all.
  // CONFIG.PROMPT_VERSION is the documented lever for exactly this, so it belongs in the key.
  const policyVersion = CONFIG.PROMPT_VERSION;
  const elisionId = computeElisionId({ toolName: toolName || 'unknown', args, originalText: text });
  const cacheKey = crypto.createHash('sha256').update(text + (task||'') + (toolName||'') + policyVersion).digest('hex');

  const db = getDb();
  const cached = db.prepare('SELECT value FROM cache WHERE key = ?').get(cacheKey) as { value: string } | undefined;
  if (cached) {
    return { text: cached.value, fidelity: blankFidelity('cache_hit') };
  }

  // Commit the uncompressed original to the DB for recovery via `expand_elision`
  let ranges: any = { startLine: 0, endLine: text.split('\n').length - 1 };
  writeElision({
    id: elisionId,
    tool_name: toolName || 'unknown',
    args: JSON.stringify(args || {}),
    original_text: text,
    ranges: JSON.stringify(ranges),
    content_hash: crypto.createHash('sha256').update(text).digest('hex'),
    size_bytes: Buffer.byteLength(text, 'utf8')
  });

  // Default to keeping the whole text
  let processedText = text;

  // Domain-Specific Deterministic Heuristics
  // Lower-case entries only: they are matched against the lower-cased tool name.
  if (toolName && ['read_file', 'view_file', 'file_read'].some(t => toolName.toLowerCase().includes(t))) {
    const lines = text.split('\n');
    const keepLines = findRelevantRegions({ lines, task: task || '' });
    if (keepLines.length > 0 && keepLines.length < lines.length * 0.8) {
      const segments = mergeRegions(lines, keepLines);
      let newText = '';
      let lastEnd = -1;
      
      for (const seg of segments) {
        if (seg.start > lastEnd + 1) {
          const elidedCount = seg.start - (lastEnd + 1);
          newText += formatElisionMarker({ elisionId: elisionId, elidedLinesCount: elidedCount, startLine: lastEnd + 1, endLine: seg.start - 1 });
        }
        newText += seg.lines.join('\n') + '\n';
        lastEnd = seg.end;
      }
      if (lastEnd < lines.length - 1) {
        const elidedCount = lines.length - 1 - lastEnd;
        newText += formatElisionMarker({ elisionId: elisionId, elidedLinesCount: elidedCount, startLine: lastEnd + 1, endLine: lines.length - 1 });
      }
      processedText = newText.trim();
    }
  } else if (toolName && ['run_command', 'get_logs', 'execute'].some(t => toolName.toLowerCase().includes(t))) {
    const lines = text.split('\n');
    // Maintain critical telemetry: errors, stack traces, failures, and the definitive log tail
    const keepLines = new Set<number>();
    lines.forEach((line, i) => {
      if (/error|fail|exception|trace/i.test(line)) {
        for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 5); j++) {
          keepLines.add(j);
        }
      }
    });
    // Mandatory Log Tail Retention
    for (let i = Math.max(0, lines.length - 50); i < lines.length; i++) {
      keepLines.add(i);
    }
    
    if (keepLines.size < lines.length * 0.8) {
       const segments = mergeRegions(lines, Array.from(keepLines).sort((a,b)=>a-b));
       let newText = '';
       let lastEnd = -1;
       
       for (const seg of segments) {
         if (seg.start > lastEnd + 1) {
           const elidedCount = seg.start - (lastEnd + 1);
           newText += formatElisionMarker({ elisionId: elisionId, elidedLinesCount: elidedCount, startLine: lastEnd + 1, endLine: seg.start - 1 });
         }
         newText += seg.lines.join('\n') + '\n';
         lastEnd = seg.end;
       }
       processedText = newText.trim();
    }
  } else if (toolName && ['grep_search', 'list_dir', 'search'].some(t => toolName.toLowerCase().includes(t))) {
    // Greedy truncation via Top-K
    const lines = text.split('\n');
    const topK = 50; 
    if (lines.length > topK) {
       const elidedCount = lines.length - topK;
       processedText = lines.slice(0, topK).join('\n') + formatElisionMarker({ elisionId: elisionId, elidedLinesCount: elidedCount, startLine: topK, endLine: lines.length - 1 });
    }
  }

  let finalText = processedText;
  const started = Date.now();
  const stats = blankFidelity('verbatim');

  // ============================================================================
  // DISTILLATION POLICY & SLM FALLBACK
  // ============================================================================
  
  const isSkill = (toolName && /skill/i.test(toolName));
  const resolvedToolName = toolName || (isSkill ? 'skill' : 'unknown');
  
  /**
   * Determine the handling fidelity mode for this specific tool.
   * - 'verbatim': Skip SLM summarization entirely.
   * - 'structural': Preserve AST structures, defer truncation to the hard limit.
   * - 'summarize': Proceed with full SLM compression.
   */
  let fidelity = getDistillPolicy(resolvedToolName);
  
  // DISTILL_SKILLS is the one switch for skill payloads. Off: verbatim, whatever the policy table says, so
  // skill instruction contracts are never touched by summarisation. On: summarize — the seeded policy rows
  // (`%skill%` → verbatim) are the "off" default, not an override; without this the switch had no effect.
  if (isSkill) {
    fidelity = CONFIG.DISTILL_SKILLS ? 'summarize' : 'verbatim';
  }

  let skillBypassFired = false;
  let adaptivePreservedCount = 0;

  if (fidelity === 'verbatim') {
    skillBypassFired = true;
    log.info('distill', 'bypass: verbatim mode enforced', { tool: resolvedToolName });
  } else if (fidelity === 'structural' && estimateTokens(finalText) > maxTokens) {
    // Structural mode relies purely on the Hard Truncation check at the bottom of this file.
    // We skip the SLM Semantic loop because structural integrity is more important than size.
    stats.mode = 'structural';
  } else if (estimateTokens(finalText) > maxTokens) {
    stats.mode = 'summarize';
    // --------------------------------------------------------------------------
    // SUMMARIZE MODE
    //
    // Some lines in the payload are "protected": contract lines, signatures, anything
    // the caller must receive character-for-character. Everything else is ordinary
    // prose we're allowed to shorten.
    //
    // The obvious approach is to hand the model the whole payload with the protected
    // lines swapped for markers like ⟦PRESERVE_3⟧, ask it to leave the markers alone,
    // and put the real lines back afterwards. We tried that. On a 5KB markdown payload
    // with nine markers, qwen2.5-coder:3b returned none of them. It didn't garble them —
    // it ignored the instruction completely and summarised everything, protected lines
    // included. There was no way to tell which parts were still exact, so the entire
    // result had to be discarded and the payload went out uncompressed.
    //
    // That isn't a wording problem. A 3B model summarises prose well, but it will not
    // reliably carry meaningless tokens through a rewrite, and no prompt tuning fixes it.
    //
    // So we never show the model the protected content at all:
    //
    //   1. Split the payload into alternating runs — protected, prose, protected, ...
    //   2. Send only the prose runs to the model to be shortened.
    //   3. Stitch the result back together, taking the protected runs from our own
    //      copy rather than from anything the model returned.
    //
    // Reassembly is pure string joining. The protected content is physically never in
    // the model's input or output, so it cannot be dropped or altered — which is what
    // makes this safe to run on a 3B model.
    // --------------------------------------------------------------------------
    const slmLines = finalText.split('\n');
    const protectedLineIndices = new Set<number>();
    
    // Phase 1: Structural Tokenization
    // We use MarkdownIt to build an AST of the payload. We extract the start/end lines
    // of critical structures (code fences, tables, frontmatter) so they aren't split.
    try {
      const md = new MarkdownIt();
      const tokens = md.parse(finalText, {});
      
      const protectNode = (start: number, end: number) => {
        for (let i = start; i < end; i++) protectedLineIndices.add(i);
      };

      for (const token of tokens) {
        if (!token.map) continue;
        const [start, end] = token.map;
        
        // Protect structural blocks
        if (['fence', 'table_open', 'blockquote_open', 'heading_open', 'front_matter'].includes(token.type)) {
          protectNode(start, end);
        } 
        // Protect explicitly marked verbatim HTML blocks from TLS
        else if (token.type === 'html_block' && token.content.includes('slm-gate:verbatim-start')) {
          protectNode(start, end);
        }
      }
    } catch (e) {
      log.warn('distill', 'Structural parsing failed', { error: e });
    }

    // Phase 1b: the whole YAML frontmatter block. markdown-it emits a `front_matter` token only with a
    // plugin this file does not load, and the `^---` preserve pattern protects the two fence lines only.
    if (slmLines[0]?.trim() === '---') {
      const close = slmLines.findIndex((line, i) => i > 0 && line.trim() === '---');
      for (let i = 0; i <= (close === -1 ? slmLines.length - 1 : close); i++) protectedLineIndices.add(i);
    }

    // Phase 2: user-supplied preserve patterns, plus elision markers from an earlier pass.
    for (let i = 0; i < slmLines.length; i++) {
      const line = slmLines[i];
      if (preservePatterns.some(p => p.test(line)) || line.includes('lines elided [id:')) {
        protectedLineIndices.add(i);
      }
    }

    // Phase 2b: learned protections. Every sentence the brain once reported missing from a
    // shortened run is stored in the ledger; a line that contains one is protected by code from now on, so
    // the same loss never recurs and the list grows with use instead of with pattern edits. Skills only
    // (the brain check is what learns), matched on the normalised line.
    const learned = verify ? learnedProtections() : [];
    if (learned.length > 0) {
      for (let i = 0; i < slmLines.length; i++) {
        if (protectedLineIndices.has(i)) continue;
        const line = normaliseProtection(slmLines[i]);
        if (line.length >= 12 && learned.some(pattern => line.includes(pattern))) {
          protectedLineIndices.add(i);
          stats.learnedProtected++;
        }
      }
    }

    // Phase 3: Adaptive Semantic Feedback Loop. Probabilistically sample unprotected lines; if
    // one closely matches text a user previously pulled back with expand_elision, protect it
    // preemptively. (The list is empty unless DISTILL_ADAPTIVE is on.)
    const pastFeedback = CONFIG.DISTILL_ADAPTIVE ? getDistillFeedback(resolvedToolName) : [];
    if (pastFeedback.length > 0) {
      for (let i = 0; i < slmLines.length; i++) {
        const line = slmLines[i];
        if (protectedLineIndices.has(i) || line.trim().length < 20) continue;
        // The explore rate is the FRACTION OF LINES that get an embedding call (0.15 = 15%), as
        // .env.example documents. Each call is a serial
        // round-trip to the embedding model, so sampling is what keeps it off the critical path.
        if (Math.random() >= CONFIG.DISTILL_ADAPTIVE_EXPLORE_RATE) continue;

        const emb = await embedText(line);
        if (!emb) continue;
        let maxSim = 0;
        for (const fb of pastFeedback) {
          const sim = cosineSimilarity(emb, bufferToFloat64Array(fb.embedding_blob));
          if (sim > maxSim) maxSim = sim;
        }
        if (maxSim >= CONFIG.DISTILL_ADAPTIVE_THRESHOLD) {
          protectedLineIndices.add(i);
          adaptivePreservedCount++;
        }
      }
    }

    if (adaptivePreservedCount > 0) {
      log.info('distill', 'Adaptive loop preemptively preserved regions based on semantic memory', { regions: adaptivePreservedCount });
    }

    // Phase 4: collapse the line map into contiguous protected / narrative runs.
    const segments: { protected: boolean; lines: string[] }[] = [];
    for (let i = 0; i < slmLines.length; i++) {
      const isProtected = protectedLineIndices.has(i);
      const current = segments[segments.length - 1];
      if (current && current.protected === isProtected) current.lines.push(slmLines[i]);
      else segments.push({ protected: isProtected, lines: [slmLines[i]] });
    }

    // Phase 5: compress narrative runs through a small worker pool. Protected runs are never
    // sent anywhere. A run is handed to the model only when a worker is free, so the per-call
    // timeout (started inside `slm`) measures generation time, not time spent in Ollama's queue.
    const protectedBlocks = segments.filter(s => s.protected).map(s => s.lines.join('\n'));
    const narrativeRuns = segments.filter(s => !s.protected);
    const queue = narrativeRuns.filter(s => s.lines.join('\n').trim().length >= MIN_COMPRESSIBLE_SEGMENT_CHARS);
    const skippedUnderFloor = narrativeRuns.length - queue.length;
    let failedRuns = 0;

    // Fidelity guard caps (only with a brain check, i.e. skills): at most DISTILL_FIDELITY_MAX_RUNS runs are
    // compressed and checked, inside DISTILL_FIDELITY_BUDGET_MS for the whole document. Beyond either cap a run
    // stays verbatim — fail closed, never cut.
    stats.runs = queue.length;
    if (verify && queue.length > CONFIG.DISTILL_FIDELITY_MAX_RUNS) {
      stats.runsSkippedBudget += queue.length - CONFIG.DISTILL_FIDELITY_MAX_RUNS;
      queue.length = CONFIG.DISTILL_FIDELITY_MAX_RUNS;
    }
    const deadline = verify ? started + CONFIG.DISTILL_FIDELITY_BUDGET_MS : Number.POSITIVE_INFINITY;
    let recallSum = 0;
    // Sentences the brain reported missing: kept verbatim now, and learned (Phase 2b) for every later run.
    const lostSentences: string[] = [];
    const keepVerbatim = (why: string) => { stats.runsKept++; stats.lost.push(why); };

    const compressRun = async (segment: { lines: string[] }) => {
      const original = segment.lines.join('\n');
      if (Date.now() > deadline) { stats.runsSkippedBudget++; return; }
      try {
        const summary = (await slm(original, task)).trim();
        // Accept only a non-empty result that actually shrank; otherwise keep the original.
        if (!(summary.length > 0 && summary.length < original.length)) return;
        if (Date.now() > deadline) { stats.runsSkippedBudget++; return; }
        if (verify) {
          const inventory = requirementInventory(original);
          if (inventory.length > MAX_INVENTORY) return keepVerbatim(`inventory_overflow(${inventory.length})`);
          if (inventory.length > 0) {
            let kept: boolean[];
            try {
              kept = await verify({ inventory, compressed: summary });
            } catch (err) {
              stats.runsKept++;
              stats.errors.push(`check_failed: ${err instanceof Error ? err.message : String(err)}`);
              return;
            }
            if (Date.now() > deadline) { stats.runsSkippedBudget++; return; }
            if (kept.length !== inventory.length) return keepVerbatim(`check_length_mismatch(${kept.length}/${inventory.length})`);
            const missing = inventory.filter((_, i) => !kept[i]);
            const recall = 1 - missing.length / inventory.length;
            stats.runsChecked++;
            recallSum += recall;
            if (recall < CONFIG.DISTILL_FIDELITY_MIN) {
              stats.runsKept++;
              stats.lost.push(...missing);
              lostSentences.push(...missing);
              return;
            }
          }
        }
        segment.lines = summary.split('\n');
      } catch (err) {
        // Fail open for THIS run only — every other run still compresses.
        failedRuns++;
        stats.errors.push(`compress_failed: ${err instanceof Error ? err.message : String(err)}`);
        log.warn('distill', 'segment kept verbatim after compression failure', { error: err });
      }
    };

    const workerCount = Math.min(MAX_CONCURRENT_SEGMENT_CALLS, queue.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      for (let run = queue.shift(); run; run = queue.shift()) {
        await compressRun(run);
      }
    }));

    const rebuilt = segments.map(s => s.lines.join('\n')).join('\n');

    // Summarize mode can legitimately change nothing: a heading-dense document splits into many
    // narrative runs that each fall under the size floor. Without this line the payload would
    // then be hard-truncated below with no trace of WHY compression was never attempted.
    if (estimateTokens(rebuilt) > maxTokens) {
      const sentRuns = narrativeRuns.length - skippedUnderFloor;
      log.warn('distill', 'summarize left the text over budget; hard truncation follows', {
        tokens: estimateTokens(rebuilt), budget: maxTokens, runs: narrativeRuns.length,
        under_floor: skippedUnderFloor, floor_chars: MIN_COMPRESSIBLE_SEGMENT_CHARS, sent: sentRuns, failed: failedRuns,
      });
    }

    // Invariant, not a discard path. Protected runs are spliced back from our own copy, so this
    // can only trip if the segmentation is wrong — never because a model misbehaved.
    const lost = protectedBlocks.filter(block => !rebuilt.includes(block));
    // Belt and braces for the same guarantee: tool names and unit quantities of the original must be in
    // the rebuilt text, whatever run they sat in.
    const lostTokens = fidelityTokens(finalText).filter(token => !rebuilt.includes(token));
    if (lost.length === 0 && lostTokens.length === 0) {
      finalText = rebuilt;
    } else {
      stats.deterministic = 0;
      stats.lost.push(...lost.map(block => `protected_block: ${block.slice(0, 60)}`), ...lostTokens);
      log.warn('distill', `distill_fallback: ${lost.length} protected block(s) and ${lostTokens.length} tracked token(s) missing after reassembly; keeping the original text`);
    }
    stats.recall = stats.runsChecked > 0 ? Number((recallSum / stats.runsChecked).toFixed(3)) : null;
    if (lostSentences.length > 0) stats.learnedNew = recordLostSentences({ sentences: lostSentences, toolName: resolvedToolName });

    // Constraint: a fidelity guard fails closed. A skill still over budget after shrinking would now be cut
    // in the middle by the hard truncation below, after passing the guard. Send the ORIGINAL instead (cut
    // with a marker, exactly as a verbatim skill is sent today) and say so; the compressed text is dropped.
    if (isSkill && finalText !== text && estimateTokens(finalText) > maxTokens) {
      finalText = text;
      stats.mode = 'not_shrunk';
    }
  }

  // Hard Truncation Check: If everything fails (including SLM), slice the block to protect context windows 
  if (maxTokens > 0 && estimateTokens(finalText) > maxTokens) {
    const lines = finalText.split('\n');
    const keepHead = Math.floor((maxTokens * CHARS_PER_TOKEN) / 100);
    
    if (lines.length > keepHead * 2) {
      const headLines = lines.slice(0, keepHead);
      const tailLines = lines.slice(-keepHead);
      
      const elidedCount = lines.length - (keepHead * 2);
      // expand_elision reads the stored ORIGINAL. Line numbers are only meaningful when this
      // text still is the original; after distillation they would point at the wrong lines.
      const linesMatchOriginal = finalText === text;
      finalText = headLines.join('\n') +
                  (linesMatchOriginal
                    ? formatElisionMarker({ elisionId: elisionId, elidedLinesCount: elidedCount, startLine: keepHead, endLine: lines.length - keepHead - 1 })
                    : formatElisionMarker({ elisionId: elisionId, elidedLinesCount: elidedCount })) +
                  tailLines.join('\n');
    }
  }

  // Memorize the computed result (for 'not_shrunk' that is the original's deterministic cut, never model output).
  // Not when a run failed: a model outage would otherwise freeze the verbatim text in the cache until
  // PROMPT_VERSION changes; skipping the write makes the next call try again.
  if (stats.errors.length === 0) {
    db.prepare('INSERT OR REPLACE INTO cache (key, value, ts) VALUES (?, ?, ?)').run(cacheKey, finalText, new Date().toISOString());
  }

  stats.elapsedMs = Date.now() - started;
  return { text: finalText, fidelity: stats };
}
