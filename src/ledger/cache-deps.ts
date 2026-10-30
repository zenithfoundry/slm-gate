/**
 * The conditioning cache (key → conditioned text) and the repository state each cached entry relied on
 * (condition_deps), so a hit is served only while every recorded path still has the same mtime and no
 * expiry has passed.
 */
import fs from 'node:fs';
import { getDb } from './db.js';

export function cacheGet(key: string): string | null {
  const statement = getDb().prepare('SELECT value FROM cache WHERE key = ?');
  const row = statement.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function cacheSet(key: string, value: string) {
  const statement = getDb().prepare('INSERT OR REPLACE INTO cache (key, value, ts) VALUES (?, ?, ?)');
  statement.run(key, value, new Date().toISOString());
}

/** One thing a cached conditioning relied on: a file or directory at a given mtime, optionally with an expiry. */
export interface CacheDependency {
  path: string;
  /** Whole milliseconds, as `Math.round(fs.statSync(path).mtimeMs)`. */
  mtime: number;
  /** ISO date after which the cached result must not be served, or null. */
  expiresAt: string | null;
}

/** Replaces the dependency rows of one cache key (none → the key has no dependencies). */
export function writeCacheDeps(key: string, deps: CacheDependency[]): void {
  const db = getDb();
  const clear = db.prepare('DELETE FROM condition_deps WHERE key = ?');
  const insert = db.prepare('INSERT OR REPLACE INTO condition_deps (key, path, mtime, expires_at) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    clear.run(key);
    for (const dep of deps) insert.run(key, dep.path, dep.mtime, dep.expiresAt);
  })();
}

/**
 * True when a cached conditioning may still be served: every recorded path exists with the same mtime and no
 * expiry has passed. A key with no rows is always fresh (today's rows). `statMtime` resolves a path to its
 * current value; returning undefined defers to the file system, which is how a pseudo-path such as
 * `index:<root>` (the repo index revision, the repository index) is answered from the ledger instead of a stat.
 */
export function cacheDepsFresh(key: string, options: { now?: Date; statMtime?: (path: string) => number | null | undefined } = {}): boolean {
  const now = options.now ?? new Date();
  const statMtime = (filePath: string): number | null => {
    const custom = options.statMtime?.(filePath);
    return custom === undefined ? defaultStatMtime(filePath) : custom;
  };
  const rows = getDb().prepare('SELECT path, mtime, expires_at FROM condition_deps WHERE key = ?').all(key) as { path: string; mtime: number; expires_at: string | null }[];
  for (const row of rows) {
    if (row.expires_at) {
      const until = new Date(row.expires_at);
      if (!Number.isNaN(until.getTime()) && until.getTime() < now.getTime()) return false;
    }
    if (statMtime(row.path) !== row.mtime) return false;
  }
  return true;
}

function defaultStatMtime(filePath: string): number | null {
  try {
    return Math.round(fs.statSync(filePath).mtimeMs);
  } catch {
    return null;
  }
}
