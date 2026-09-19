import fs from 'fs/promises';
import { CONFIG } from '../config.js';

/**
 * A rigid set of baseline RegExp patterns used to identify lines that MUST NEVER be dropped
 * during local offline Small Language Model (SLM) contextual compression.
 * 
 * The system ensures that any line matching these patterns is explicitly preserved and shielded 
 * via placeholder substitution before handing the text to the SLM. This guarantees that 
 * critical structural integrity, hard requirements, and specific directives survive the 
 * lossy distillation process.
 */
export const BUILTIN_PATTERNS: RegExp[] = [
  // requirement keywords
  /.*(?:MUST|MUST NOT|SHALL|REQUIRED|SHOULD NOT|NEVER|ALWAYS|DO NOT|MANDATORY|PROHIBITED|IMPORTANT|CRITICAL|WARNING|CAUTION).*/i,
  // markdown headings
  /^#{1,6}\s/,
  // numbered steps
  /^\s*\d+[.)]\s/,
  // checklist items
  /^\s*[-*]\s+\[[ xX]\]/,
  // fenced code blocks / inline code lines (contain backticks)
  /`/,
  // URLs
  /https?:\/\//,
  // path/KEY[:=]value config lines
  /^[A-Za-z0-9_.\/-]+[:=]/,
  // output/format directives
  /(?:format:|respond with|output must|Answer:)/i,
  // hard quantities
  /(?:no more than \d|at most|exactly \d|maximum|minimum)/i,
  // YAML frontmatter block markers
  /^---/,
];

/**
 * Attempts to compile a regular expression string into an executable RegExp object.
 * It first attempts to use `re2` (a fast, linear-time regex engine safe against ReDoS attacks) 
 * if installed. If `re2` is missing or rejects the pattern (e.g., due to unsupported features 
 * like complex lookaheads), it gracefully falls back to the native V8 RegExp engine.
 *
 * @param pattern - The raw regular expression string to compile
 * @returns The compiled RegExp instance, or null if the pattern is fatally invalid
 */
async function compilePattern(pattern: string): Promise<RegExp | null> {
  let Re2: typeof RegExp | undefined;
  try {
    // @ts-ignore - optional dependency
    Re2 = (await import('re2')).default;
  } catch {
    // re2 not installed, will fallback
  }

  if (Re2) {
    try {
      return new Re2(pattern);
    } catch (e) {
      // Re2 threw (e.g. unsupported syntax like lookaheads), fallback to native RegExp
    }
  }

  try {
    return new RegExp(pattern);
  } catch (e) {
    console.error(`[distill] Warning: Skipping invalid regex pattern: ${pattern}`);
    return null;
  }
}

/**
 * Constructs the aggregate array of preservation Regex patterns for the current session.
 * Depending on the configuration (`DISTILL_PRESERVE_MODE`), it will either:
 * - 'extend': Combine `BUILTIN_PATTERNS`, user-defined JSON patterns, and adapter-specific patterns.
 * - 'replace': Ignore `BUILTIN_PATTERNS` entirely, relying only on user/adapter specifications.
 *
 * @returns A promise resolving to the final array of compiled RegExp patterns
 */
export async function buildPreserveList(): Promise<RegExp[]> {
  let patterns: RegExp[] = [];
  const mode = CONFIG.DISTILL_PRESERVE_MODE || 'extend';

  if (mode === 'extend') {
    patterns = [...BUILTIN_PATTERNS];
  }

  // Load custom preservation patterns defined in an external JSON file by the user
  if (CONFIG.DISTILL_PRESERVE_PATH) {
    try {
      const data = await fs.readFile(CONFIG.DISTILL_PRESERVE_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed.patterns)) {
        for (const p of parsed.patterns) {
          const compiled = await compilePattern(p);
          if (compiled) {
            patterns.push(compiled);
          }
        }
      }
    } catch (e) {
      console.error(`[distill] Warning: Failed to read or parse user preserve patterns from ${CONFIG.DISTILL_PRESERVE_PATH}`);
    }
  }

  // Optionally load tech-lead-stack patterns if running in decoupled integration mode
  if (CONFIG.TLS_ADAPTER) {
    try {
      // Guarded dynamic import
      // @ts-ignore - Decoupling: adapter may not exist in pure MCP-gate configurations
      const adapter = await import('../adapters/tech-lead-stack.js');
      if (adapter.tlsPreservePatterns) {
        patterns.push(...adapter.tlsPreservePatterns);
      }
    } catch (e) {
      console.error(`[distill] Warning: Failed to load TLS adapter patterns`, e);
    }
  }

  return patterns;
}


