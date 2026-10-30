/**
 * The repository symbol index store (REPO_INDEX=on): per-file symbol rows in FTS5, the mtime each file
 * was indexed at and a per-root revision that moves whenever a file changed. The indexer that fills it
 * lives in src/index/repo-index.ts.
 */
import { getDb } from './db.js';
import { ftsQuery } from './decisions.js';

/** The indexed mtime of every file of one root (empty when never indexed). */
export function repoFileMtimes(root: string): Map<string, number> {
  const rows = getDb().prepare('SELECT path, mtime FROM repo_files WHERE root = ?').all(root) as { path: string; mtime: number }[];
  return new Map(rows.map(r => [r.path, r.mtime]));
}

/** Replaces one file's symbol rows and records the mtime they were extracted at. */
export function replaceRepoFileSymbols(params: { root: string; path: string; mtime: number; symbols: { line: number; kind: string; name: string; tokens: string; signature: string }[] }): void {
  const { root, path: filePath, mtime, symbols } = params;
  const db = getDb();
  const clear = db.prepare('DELETE FROM repo_fts WHERE root = ? AND path = ?');
  const insert = db.prepare('INSERT INTO repo_fts (root, path, line, kind, name, tokens, signature) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const mark = db.prepare('INSERT OR REPLACE INTO repo_files (root, path, mtime) VALUES (?, ?, ?)');
  db.transaction(() => {
    clear.run(root, filePath);
    for (const s of symbols) insert.run(root, filePath, s.line, s.kind, s.name, s.tokens, s.signature);
    mark.run(root, filePath, mtime);
  })();
}

/** Drops a file that no longer exists from the index. */
export function deleteRepoFile(root: string, filePath: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM repo_fts WHERE root = ? AND path = ?').run(root, filePath);
    db.prepare('DELETE FROM repo_files WHERE root = ? AND path = ?').run(root, filePath);
  })();
}

/** The root's index revision; 0 when never indexed. */
export function repoIndexRevision(root: string): number {
  return (getDb().prepare('SELECT revision FROM repo_index WHERE root = ?').pluck().get(root) as number | undefined) ?? 0;
}

/** Moves the root's revision forward by one and returns it. */
export function bumpRepoIndexRevision(root: string): number {
  const next = repoIndexRevision(root) + 1;
  getDb().prepare('INSERT OR REPLACE INTO repo_index (root, revision) VALUES (?, ?)').run(root, next);
  return next;
}

/** Symbols of one root matching the query's words (bm25 over name, identifier words and signature). */
export function searchRepoSymbols(params: { root: string; query: string; limit?: number }): { path: string; line: number; kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'const'; name: string; signature: string }[] {
  const { root, query, limit = 10 } = params;
  const fts = ftsQuery(query);
  if (!fts) return [];
  return getDb().prepare('SELECT path, line, kind, name, signature FROM repo_fts WHERE root = ? AND repo_fts MATCH ? ORDER BY bm25(repo_fts, 0, 0, 0, 0, 2.0, 3.0, 1.0) LIMIT ?')
    .all(root, fts, limit) as ReturnType<typeof searchRepoSymbols>;
}
