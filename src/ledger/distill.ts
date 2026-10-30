/**
 * What the model gate decided for each tool result (llm_distilled: the first decision wins and every
 * later request resends the same bytes), the distillation feedback rows, and the tool-pattern → fidelity
 * policy table both gates consult.
 */
import { log } from '../log.js';
import { getDb } from './db.js';

export interface DistillPolicyRow {
  tool_pattern: string;
  fidelity: 'verbatim' | 'structural' | 'summarize';
  priority: number;
  updated_at: string;
}

export interface DistillFeedbackRow {
  id: string;
  tool_name: string;
  skill: string;
  content_hash: string;
  region_text: string;
  embedding_blob: Buffer;
  signal: number;
  created_at: string;
}

/** What the model gate sent for one tool result: the text and why (distilled, original, timeout, error). */
export interface DistillDecision {
  text: string;
  outcome: string;
}

/** The model gate's stored decision for a tool result, or null when it has none. Throws on database errors. */
export function getDistillDecision(key: string): DistillDecision | null {
  const row = getDb().prepare('SELECT text, outcome FROM llm_distilled WHERE key = ?').get(key) as DistillDecision | undefined;
  return row ?? null;
}

/**
 * Stores a decision unless one already exists and returns the one that stands; the caller must send
 * exactly that text. Insert and read-back share one transaction, so a decision is never on disk
 * without the caller knowing it. Throws on database errors (e.g. the gate's short busy timeout), in
 * which case nothing was stored.
 */
export function recordDistillDecision(params: { key: string; text: string; outcome: string }): DistillDecision {
  const db = getDb();
  return db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO llm_distilled (key, text, outcome, created_at) VALUES (?, ?, ?, ?)')
      .run(params.key, params.text, params.outcome, new Date().toISOString());
    return db.prepare('SELECT text, outcome FROM llm_distilled WHERE key = ?').get(params.key) as DistillDecision;
  })();
}

export function writeDistillFeedback(row: Omit<DistillFeedbackRow, 'created_at'>) {
  const db = getDb();
  if (!db) return;
  try {
    const stmt = db.prepare(`
      INSERT INTO distill_feedback (id, tool_name, skill, content_hash, region_text, embedding_blob, signal, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(row.id, row.tool_name, row.skill, row.content_hash, row.region_text, row.embedding_blob, row.signal, new Date().toISOString());
  } catch (e) {
    console.error('Failed to write distill feedback', e);
  }
}

export function getDistillFeedback(toolName: string, limit = 50): DistillFeedbackRow[] {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM distill_feedback WHERE tool_name = ? ORDER BY created_at DESC LIMIT ?')
             .all(toolName, limit) as DistillFeedbackRow[];
  } catch (e) {
    return [];
  }
}

/**
 * The distillation fidelity for a tool, from the highest-priority `distill_policy` row whose pattern matches.
 * `%` is the only wildcard; every other character of a pattern is literal. A lookup failure is reported and
 * falls back to `summarize`, the table's own default row.
 */
export function getDistillPolicy(toolName: string): string {
  const db = getDb();
  if (!db) return 'summarize';
  try {
    const rows = db.prepare('SELECT tool_pattern, fidelity FROM distill_policy ORDER BY priority DESC').all() as any[];
    for (const r of rows) {
      if (r.tool_pattern === '*') return r.fidelity;
      const regexStr = String(r.tool_pattern).split('%').map(escapeRegExp).join('.*');
      if (new RegExp('^' + regexStr + '$', 'i').test(toolName)) return r.fidelity;
    }
  } catch (e) {
    log.warn('ledger', 'distill policy lookup failed; using summarize', { tool: toolName, error: e });
  }
  return 'summarize';
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
