/**
 * Learned protections: every sentence the brain once reported missing from a shortened skill run, in
 * normalised form. A line that contains one is kept verbatim from then on, so the same loss never recurs.
 */
import { getDb } from './db.js';

/**
 * The one acceptance rule for a learned protection: at least this many characters once normalised. A shorter
 * "sentence" ("Note:", "Then:") would protect every line that contains it and stop shrinking altogether. The
 * sentence it came from was kept verbatim at the time regardless (fail closed); the rule only decides what is
 * learned for later. There is no upper bound: a long sentence simply matches only the line that holds it.
 */
const PROTECT_MIN_CHARS = 12;

/** The form a learned protection is stored and matched in: lower-case, single spaces, trimmed. Pure. */
export function normaliseProtection(sentence: string): string {
  return sentence.toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface LearnedProtection {
  pattern: string;
  tool_name: string | null;
  hits: number;
  first_seen: string;
  last_seen: string;
}

/**
 * Stores the sentences the brain reported missing from a shortened run, once each; a repeat raises `hits`.
 * Returns how many were new. Sentences under PROTECT_MIN_CHARS are ignored (see the rule above).
 */
export function recordLostSentences(params: { sentences: string[]; toolName: string }): number {
  const { sentences, toolName } = params;
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO distill_protect (pattern, tool_name, hits, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(pattern) DO UPDATE SET hits = hits + 1, last_seen = excluded.last_seen
  `);
  let added = 0;
  for (const sentence of sentences) {
    const pattern = normaliseProtection(sentence);
    if (pattern.length < PROTECT_MIN_CHARS) continue;
    const info = insert.run(pattern, toolName, now, now);
    // SQLite reports an upsert's UPDATE path with changes = 1 as well, so count by lastInsertRowid change.
    if (info.changes === 1 && db.prepare('SELECT hits FROM distill_protect WHERE pattern = ?').pluck().get(pattern) === 1) added++;
  }
  return added;
}

/** Every learned protection, most often hit first, capped so the per-line match stays cheap. */
export function learnedProtections(limit = 500): string[] {
  return getDb().prepare('SELECT pattern FROM distill_protect ORDER BY hits DESC, last_seen DESC LIMIT ?').pluck().all(limit) as string[];
}

/** The full rows, for `pnpm run protections`. */
export function listProtections(): LearnedProtection[] {
  return getDb().prepare('SELECT pattern, tool_name, hits, first_seen, last_seen FROM distill_protect ORDER BY hits DESC, last_seen DESC').all() as LearnedProtection[];
}

/** Removes one learned protection by its stored or raw form; true when a row was deleted. */
export function forgetProtection(pattern: string): boolean {
  return getDb().prepare('DELETE FROM distill_protect WHERE pattern = ?').run(normaliseProtection(pattern)).changes > 0;
}
