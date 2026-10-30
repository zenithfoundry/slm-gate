/**
 * The elision store: the original text of every tool result the MCP gate cut, keyed by elision id, so
 * expand_elision and ask_elision can read it back. Size-capped by last use (ELISION_MAX_MB) and expired
 * by age (ELISION_RETENTION_DAYS).
 */
import { CONFIG } from '../config.js';
import { getDb } from './db.js';

/** How long a "last used" stamp may stay stale before a read refreshes it. */
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ElisionRecord {
  id: string;
  tool_name: string;
  args: string; // JSON
  original_text: string;
  ranges: string; // JSON
  content_hash: string;
  created_at: string;
  last_accessed_at: string;
  size_bytes: number;
}

export function writeElision(record: Omit<ElisionRecord, 'created_at' | 'last_accessed_at'>) {
  const ts = new Date().toISOString();
  
  // Size cap constraint
  const maxMb = CONFIG.ELISION_MAX_MB ?? 500;
  const maxBytes = maxMb * 1024 * 1024;
  const db = getDb();
  
  // Start a transaction for the write + eviction
  const transaction = db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO elision_cache (
        id, tool_name, args, original_text, ranges, content_hash, created_at, last_accessed_at, size_bytes
      ) VALUES (
        @id, @tool_name, @args, @original_text, @ranges, @content_hash, @created_at, @last_accessed_at, @size_bytes
      )
    `);
    
    insertStmt.run({
      ...record,
      created_at: ts,
      last_accessed_at: ts
    });

    // Evict oldest by last_accessed_at if we exceed max size
    db.prepare(`
      DELETE FROM elision_cache 
      WHERE id IN (
        SELECT id FROM (
          SELECT id, sum(size_bytes) OVER (ORDER BY last_accessed_at DESC) as running_total
          FROM elision_cache
        ) WHERE running_total > ?
      )
    `).run(maxBytes);
  });

  transaction();
}

export function getElision(id: string): ElisionRecord | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM elision_cache WHERE id = ?`).get(id) as ElisionRecord | undefined;
  
  if (row) {
    // Lazy expiry check
    const retentionDays = CONFIG.ELISION_RETENTION_DAYS ?? 180;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    
    if (new Date(row.created_at) < cutoffDate) {
      db.prepare(`DELETE FROM elision_cache WHERE id = ?`).run(id);
      return null;
    }

    // The "last used" stamp orders the size-cap eviction in writeElision. A write per read is not worth
    // that, so a row is stamped at most once a day.
    if (Date.now() - new Date(row.last_accessed_at).getTime() > TOUCH_INTERVAL_MS) {
      db.prepare(`UPDATE elision_cache SET last_accessed_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
    }
    return row;
  }
  
  return null;
}
