/**
 * Conversation memory (docs/briefs/2026-10-22-conversation-memory.md): one running summary per
 * conversation, folded by the model gate and read back by the local steps through matchMemory, which
 * fails closed. The summary text lives only in this table.
 */
import { CONFIG } from '../config.js';
import { getDb } from './db.js';

export interface MemoryRow {
  key: string;
  root: string | null;
  summary: string;
  turns: number;
  discriminator: string | null;
  started_at: string;
  folded_at: string;
  fold_failed_at: string | null;
  fold_count: number;
  fold_ms: number | null;
  prompt_version: string;
}

/**
 * The stored row as it is, failed folds and all. For fold recovery ONLY, so a retry continues from the
 * previous summary and cursor. Feature readers use `matchMemory`, which fails closed.
 */
export function readMemoryRow(key: string): MemoryRow | null {
  return (getDb().prepare('SELECT * FROM conversation_memory WHERE key = ?').get(key) as MemoryRow | undefined) ?? null;
}

/** Writes a successful fold: the whole row, `fold_failed_at` cleared. */
export function writeMemoryRow(row: Omit<MemoryRow, 'fold_failed_at'>): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO conversation_memory
      (key, root, summary, turns, discriminator, started_at, folded_at, fold_failed_at, fold_count, fold_ms, prompt_version)
    VALUES (@key, @root, @summary, @turns, @discriminator, @started_at, @folded_at, NULL, @fold_count, @fold_ms, @prompt_version)
  `).run(row);
}

/** Records a failed fold on an existing row (summary and cursor untouched); no-op when the row does not exist. */
export function markMemoryFoldFailed(key: string, at: string): void {
  getDb().prepare('UPDATE conversation_memory SET fold_failed_at = ? WHERE key = ?').run(at, key);
}

/** Every row, newest fold first, for `slm-gate memory`. */
export function listMemoryRows(): MemoryRow[] {
  return getDb().prepare('SELECT * FROM conversation_memory ORDER BY folded_at DESC').all() as MemoryRow[];
}

/** Which rule found a memory, recorded as `meta.memory.match` on the rows that used it. */
export type MemoryMatch = 'key' | 'root-recent' | 'none';

/**
 * The ONE read path for every feature reader; it fails closed. Returns `none` when the feature is off (stored
 * rows included), when the newest fold failed, when the last good fold is older than `MEMORY_MATCH_WINDOW_MS`,
 * or when the row was written under another PROMPT_VERSION. The model gate passes the conversation `key` (and
 * the request's `discriminator`, which must agree with the stored one when both exist); the MCP gate has no
 * key and passes `root` plus its own `startedAfter` time: the newest usable row for that workspace whose
 * conversation began at or after the MCP session did.
 */
export function matchMemory(params: { key?: string; discriminator?: string | null; root?: string | null; startedAfter?: string; now?: Date }): { row: MemoryRow | null; match: MemoryMatch } {
  const none = { row: null, match: 'none' as const };
  if (!CONFIG.CONVERSATION_MEMORY) return none;
  const now = params.now ?? new Date();
  const usable = (row: MemoryRow | undefined | null): row is MemoryRow => {
    if (!row) return false;
    if (row.prompt_version !== CONFIG.PROMPT_VERSION) return false;
    // At or after the last good fold (a success clears the mark, so equal means the failure came later).
    if (row.fold_failed_at && row.fold_failed_at >= row.folded_at) return false;
    return now.getTime() - new Date(row.folded_at).getTime() <= CONFIG.MEMORY_MATCH_WINDOW_MS;
  };
  if (params.key) {
    // A fork (same opening, different second entry) lives under key:discriminator and wins when it exists.
    const forkRow = params.discriminator ? readMemoryRow(`${params.key}:${params.discriminator}`) : null;
    const row = usable(forkRow) ? forkRow : readMemoryRow(params.key);
    if (!usable(row)) return none;
    if (row.discriminator && params.discriminator && row.discriminator !== params.discriminator) return none;
    return { row, match: 'key' };
  }
  if (params.root) {
    const rows = getDb().prepare('SELECT * FROM conversation_memory WHERE root = ? ORDER BY folded_at DESC').all(params.root) as MemoryRow[];
    const row = rows.find(r => usable(r) && (!params.startedAfter || r.started_at >= params.startedAfter));
    return row ? { row, match: 'root-recent' } : none;
  }
  return none;
}
