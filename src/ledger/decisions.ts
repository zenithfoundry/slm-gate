/**
 * Decision memory: one FTS5 index over every repo's .slm-gate/decisions files, rebuilt per repo when its
 * revision moves and searched with bm25. Also home of the FTS5 query builder the symbol index shares.
 */
import { getDb } from './db.js';

/** The revision the repo's decision index was built from, or null when never indexed. */
export function decisionIndexRevision(root: string): string | null {
  return (getDb().prepare('SELECT revision FROM decisions_index WHERE root = ?').pluck().get(root) as string | undefined) ?? null;
}

/** Rebuilds one repo's decision rows in the FTS index and records the revision. */
export function replaceDecisionIndex(params: { root: string; revision: string; rows: { path: string; title: string; body: string }[] }): void {
  const { root, revision, rows } = params;
  const db = getDb();
  const clear = db.prepare('DELETE FROM decisions_fts WHERE root = ?');
  const insert = db.prepare('INSERT INTO decisions_fts (root, path, title, body) VALUES (?, ?, ?, ?)');
  const mark = db.prepare('INSERT OR REPLACE INTO decisions_index (root, revision) VALUES (?, ?)');
  db.transaction(() => {
    clear.run(root);
    for (const row of rows) insert.run(root, row.path, row.title, row.body);
    mark.run(root, revision);
  })();
}

/** Words of a question as an FTS5 OR-query: letters and digits only, each quoted, three characters or more. */
export function ftsQuery(text: string): string | null {
  const words = [...new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []))];
  return words.length === 0 ? null : words.map(w => `"${w}"`).join(' OR ');
}

/** The best-ranked decisions of one repo for a question (bm25), or none when the question has no usable words. */
export function searchDecisions(params: { root: string; query: string; limit?: number }): { path: string; title: string; rank: number }[] {
  const { root, query, limit = 1 } = params;
  const fts = ftsQuery(query);
  if (!fts) return [];
  return getDb().prepare('SELECT path, title, bm25(decisions_fts) AS rank FROM decisions_fts WHERE root = ? AND decisions_fts MATCH ? ORDER BY rank LIMIT ?')
    .all(root, fts, limit) as { path: string; title: string; rank: number }[];
}
