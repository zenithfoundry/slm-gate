import MarkdownIt from 'markdown-it';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { getDb, getDistillFeedback, getDistillPolicy, writeElision } from '../ledger/index.js';
import { bufferToFloat64Array, cosineSimilarity, embedText } from '../utils/embedding.js';
import { TOOL_RESULT_PREFIXES } from './constants.js';

// NOTE:: "Elision" meaning is; Leaving out a sound, a syllable, or a word part when speaking.

/**
 * Narrative runs shorter than this are left verbatim during summarize-mode compression.
 * A model round-trip on a line or two costs more wall-clock time than the tokens it saves.
 */
const MIN_COMPRESSIBLE_SEGMENT_CHARS = 400;

/**
 * Computes a deterministic SHA-256 ID for a tool elision.
 * By hashing the tool name, arguments, and original content, we ensure that
 * identical tool outputs always produce the exact same elision ID,
 * enabling safe and highly-cacheable reconstruction logic.
 *
 * @param toolName - The name of the tool (e.g., 'read_file')
 * @param args - The structured arguments provided to the tool
 * @param originalText - The complete, uncompressed raw text returned by the tool
 * @returns A unique hexadecimal SHA-256 hash identifying this exact output state
 */
export function computeElisionId(toolName: string, args: any, originalText: string): string {
  const hashText = crypto.createHash('sha256').update(originalText).digest('hex');
  const payload = `${toolName}:${JSON.stringify(args || {})}:${hashText}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Formats a clear, identifiable text marker indicating that lines were elided.
 * This marker informs downstream LLMs that content is missing and provides the `expand_elision`
 * ID they can use if they determine they actually need the omitted lines.
 *
 * @param elisionId - The unique SHA-256 hash for the original content
 * @param elidedLinesCount - Number of lines that were removed
 * @param startLine - Optional starting line index of the removed chunk
 * @param endLine - Optional ending line index of the removed chunk
 * @returns A formatted string marker designed for robust parsing
 */
export function formatElisionMarker(elisionId: string, elidedLinesCount: number, startLine?: number, endLine?: number): string {
  const rangeStr = (startLine !== undefined && endLine !== undefined) ? `, lines ${startLine}-${endLine}` : '';
  return `\n... ${elidedLinesCount} lines elided [id: ${elisionId}${rangeStr}] — call expand_elision to retrieve ...\n`;
}

/**
 * Estimates the number of tokens in a string based on a rough character-to-token heuristic.
 * Used for fast, zero-dependency short-circuiting before invoking the actual SLM.
 *
 * @param text - The text to evaluate
 * @returns Estimated token count (roughly 1 token per 3.5 characters)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
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
 * @param lines - Array of lines comprising the file
 * @param task - The active user task string, used to derive search terms
 * @param searchTerms - Explicit additional search terms to match
 * @returns A sorted array of 0-indexed line numbers that should be preserved
 */
export function findRelevantRegions(lines: string[], task: string, searchTerms: string[] = []): number[] {
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

/**
 * The core engine of Reasoned Redundancy.
 * Dynamically distills excessively large tool results into compressed representations using 
 * tool-specific deterministic policies (e.g. keeping stack traces, top-K search results, 
 * or code skeletons).
 * 
 * If the resulting output remains stubbornly above token limits, it engages a strict local 
 * SLM fallback to further distill the text, utilizing protective placeholders to guarantee 
 * invariant lines (like file paths or function identifiers) are never dropped.
 *
 * @param slm - The local offline Small Language Model integration client
 * @param text - The raw, verbose tool result text
 * @param task - The overall user directive/task string
 * @param toolName - The categorized tool name (e.g., 'read_file', 'get_logs')
 * @param args - The arguments originally passed to the tool
 * @param preservePatterns - A rigid list of RegExp patterns whose matched lines MUST survive SLM compression
 * @returns The final compressed text representation, optionally featuring elision markers
 */
export async function distillToolResult(
  slm: (text: string, task?: string) => Promise<string>,
  text: string,
  task: string | undefined,
  toolName: string | undefined,
  args: any,
  preservePatterns: RegExp[]
): Promise<string> {
  const minTokens = CONFIG.DISTILL_MIN_TOKENS ?? 500;
  const maxTokens = CONFIG.DISTILL_MAX_TOKENS ?? 2000;
  const originalTokens = estimateTokens(text);
  
  // If small enough, bypass all logic
  if (originalTokens < minTokens) {
    return text;
  }

  // Determine caching keys
  // Was a hardcoded 'v1', so a distilled result could never be invalidated at all.
  // CONFIG.PROMPT_VERSION is the documented lever for exactly this, so it belongs in the key.
  const policyVersion = CONFIG.PROMPT_VERSION;
  const elisionId = computeElisionId(toolName || 'unknown', args, text);
  const cacheKey = crypto.createHash('sha256').update(text + (task||'') + (toolName||'') + policyVersion).digest('hex');

  const db = getDb();
  const cached = db.prepare('SELECT value FROM cache WHERE key = ?').get(cacheKey) as { value: string } | undefined;
  if (cached) {
    return cached.value;
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
  if (toolName && ['read_file', 'view_file', 'File_Read'].some(t => toolName.toLowerCase().includes(t))) {
    const lines = text.split('\n');
    const keepLines = findRelevantRegions(lines, task || '');
    if (keepLines.length > 0 && keepLines.length < lines.length * 0.8) {
      const segments = mergeRegions(lines, keepLines);
      let newText = '';
      let lastEnd = -1;
      
      for (const seg of segments) {
        if (seg.start > lastEnd + 1) {
          const elidedCount = seg.start - (lastEnd + 1);
          newText += formatElisionMarker(elisionId, elidedCount, lastEnd + 1, seg.start - 1);
        }
        newText += seg.lines.join('\n') + '\n';
        lastEnd = seg.end;
      }
      if (lastEnd < lines.length - 1) {
        const elidedCount = lines.length - 1 - lastEnd;
        newText += formatElisionMarker(elisionId, elidedCount, lastEnd + 1, lines.length - 1);
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
           newText += formatElisionMarker(elisionId, elidedCount, lastEnd + 1, seg.start - 1);
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
       processedText = lines.slice(0, topK).join('\n') + formatElisionMarker(elisionId, elidedCount, topK, lines.length - 1);
    }
  }

  let finalText = processedText;
  
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
  
  // Guardrail: If DISTILL_SKILLS is off, force verbatim mode for all skill payloads
  // to guarantee skill instruction contracts are not corrupted by summarization.
  if (isSkill && !CONFIG.DISTILL_SKILLS) {
    fidelity = 'verbatim';
  }

  let skillBypassFired = false;
  let adaptivePreservedCount = 0;

  if (fidelity === 'verbatim') {
    skillBypassFired = true;
    console.error(`[distill] bypass: verbatim mode enforced for ${resolvedToolName}`);
  } else if (fidelity === 'structural' && estimateTokens(finalText) > maxTokens) {
    // Structural mode relies purely on the Hard Truncation check at the bottom of this file.
    // We skip the SLM Semantic loop because structural integrity is more important than size.
  } else if (estimateTokens(finalText) > maxTokens) {
    // --------------------------------------------------------------------------
    // SUMMARIZE MODE: segment-wise compression.
    //
    // The model is never shown protected content, and is never asked to carry placeholder
    // tokens through a rewrite. Measured on a 5KB markdown payload: asked to reproduce nine
    // ⟦PRESERVE_n⟧ tokens verbatim, qwen2.5-coder:3b kept ZERO of them. It did not mangle
    // them — it ignored the custody protocol entirely and summarised everything, protected
    // content included, so the whole compression had to be thrown away and the payload was
    // forwarded uncompressed. Small models summarise prose well. They are not reliable
    // custodians of opaque tokens, and no amount of prompt wording fixes that.
    //
    // So: split into alternating protected / narrative runs, compress ONLY the narrative
    // runs, and splice the protected runs back in from our own copy. Reassembly is then
    // deterministic and cannot drop a contract line, which is what makes this safe on a 3B.
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
      console.error('[distill] Structural parsing failed', e);
    }

    // Phase 2: user-supplied preserve patterns, plus elision markers from an earlier pass.
    for (let i = 0; i < slmLines.length; i++) {
      const line = slmLines[i];
      if (preservePatterns.some(p => p.test(line)) || line.includes('lines elided [id:')) {
        protectedLineIndices.add(i);
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
        // Explore rate keeps embedding off the critical path for most lines.
        if (Math.random() < CONFIG.DISTILL_ADAPTIVE_EXPLORE_RATE) continue;

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
      console.info(`[distill] Adaptive loop preemptively preserved ${adaptivePreservedCount} regions based on semantic memory.`);
    }

    // Phase 4: collapse the line map into contiguous protected / narrative runs.
    const segments: { protected: boolean; lines: string[] }[] = [];
    for (let i = 0; i < slmLines.length; i++) {
      const isProtected = protectedLineIndices.has(i);
      const current = segments[segments.length - 1];
      if (current && current.protected === isProtected) current.lines.push(slmLines[i]);
      else segments.push({ protected: isProtected, lines: [slmLines[i]] });
    }

    // Phase 5: compress narrative runs concurrently. Protected runs are never sent anywhere.
    const protectedBlocks = segments.filter(s => s.protected).map(s => s.lines.join('\n'));
    await Promise.all(segments.map(async (segment) => {
      if (segment.protected) return;
      const original = segment.lines.join('\n');
      if (original.trim().length < MIN_COMPRESSIBLE_SEGMENT_CHARS) return;
      try {
        const summary = (await slm(original, task)).trim();
        // Accept only a non-empty result that actually shrank; otherwise keep the original.
        if (summary.length > 0 && summary.length < original.length) {
          segment.lines = summary.split('\n');
        }
      } catch (err) {
        // Fail open for THIS run only — every other run still compresses.
        console.error(`[distill] segment kept verbatim after compression failure: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));

    const rebuilt = segments.map(s => s.lines.join('\n')).join('\n');

    // Invariant, not a discard path. Protected runs are spliced back from our own copy, so this
    // can only trip if the segmentation is wrong — never because a model misbehaved.
    const lost = protectedBlocks.filter(block => !rebuilt.includes(block));
    if (lost.length === 0) {
      finalText = rebuilt;
    } else {
      console.warn(`distill_fallback: ${lost.length} protected block(s) missing after reassembly; keeping the original text`);
    }
  }

  // Hard Truncation Check: If everything fails (including SLM), slice the block to protect context windows 
  if (maxTokens > 0 && estimateTokens(finalText) > maxTokens) {
    const lines = finalText.split('\n');
    const keepHead = Math.floor((maxTokens * 3.5) / 100);
    
    if (lines.length > keepHead * 2) {
      const headLines = lines.slice(0, keepHead);
      const tailLines = lines.slice(-keepHead);
      
      const elidedCount = lines.length - (keepHead * 2);
      finalText = headLines.join('\n') + 
                  formatElisionMarker(elisionId, elidedCount, keepHead, lines.length - keepHead - 1) + 
                  tailLines.join('\n');
    }
  }

  // Memorize the computed result
  db.prepare('INSERT OR REPLACE INTO cache (key, value, ts) VALUES (?, ?, ?)').run(cacheKey, finalText, new Date().toISOString());

  return finalText;
}
