/**
 * Opens the one SQLite ledger file: schema (CREATE IF NOT EXISTS), additive column migrations, the default
 * distill policy rows and the startup retention sweep. Holds the single connection every other ledger
 * module reaches through getDb(), so the file is opened once per process.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { log } from '../log.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    // CONFIG.LEDGER_PATH always resolves (a blank env value is treated as unset and takes the
    // absolute default under OUTPUT_DIR), so there is deliberately no cwd-relative fallback:
    // MCP hosts spawn this process with a working directory that may not exist.
    const ledgerPath = CONFIG.LEDGER_PATH;
    const dir = path.dirname(ledgerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(ledgerPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS distill_policy (
        tool_pattern TEXT PRIMARY KEY,
        fidelity TEXT CHECK (fidelity IN ('verbatim','structural','summarize')),
        priority INTEGER,
        updated_at TEXT
      );
      
      CREATE TABLE IF NOT EXISTS distill_feedback (
        id TEXT PRIMARY KEY,
        tool_name TEXT,
        skill TEXT,
        content_hash TEXT,
        region_text TEXT,
        embedding_blob BLOB,
        signal INTEGER,
        created_at TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_distill_feedback_tool ON distill_feedback(tool_name);
      CREATE INDEX IF NOT EXISTS idx_distill_feedback_created ON distill_feedback(created_at);

      CREATE TABLE IF NOT EXISTS events (
        ts TEXT,
        layer TEXT,
        request_id TEXT UNIQUE PRIMARY KEY,
        session_id TEXT,
        skill TEXT,
        route TEXT,
        is_local_call INTEGER,
        slm_model TEXT,
        api_model TEXT,
        in_tok INTEGER,
        out_tok INTEGER,
        api_in_tok INTEGER,
        api_out_tok INTEGER,
        cost_usd REAL,
        slm_latency_s REAL,
        api_latency_s REAL,
        verifier_flags TEXT,
        quality_score REAL,
        slm_gate TEXT,
        meta TEXT,
        provider TEXT,
        agent TEXT,
        environment TEXT
      );

      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT,
        ts TEXT
      );

      -- The model gate's distillation decisions: for each original tool result (by key), the exact
      -- text the gate sent. The first decision wins: every later request must resend the same bytes,
      -- or provider caches and Claude's thinking break. Pruned only after ELISION_RETENTION_DAYS,
      -- when no conversation can still be resending it (startup sweep below).
      CREATE TABLE IF NOT EXISTS llm_distilled (
        key TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- synced = 1 marks a row claimed by a flush in progress (both gates flush this queue); claimed_at
      -- lets a claim left by a process that died mid-flight be released. Shipped rows are deleted.
      CREATE TABLE IF NOT EXISTS langfuse_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT,
        synced INTEGER DEFAULT 0,
        attempts INTEGER DEFAULT 0,
        claimed_at TEXT
      );

      -- Queue rows Langfuse kept rejecting item by item. Parked here, never deleted, so a
      -- malformed row cannot block the queue and its data is still there to inspect or resend.
      CREATE TABLE IF NOT EXISTS langfuse_dead_letter (
        id INTEGER PRIMARY KEY,
        payload TEXT,
        attempts INTEGER,
        error TEXT,
        dead_at TEXT
      );

      CREATE TABLE IF NOT EXISTS elision_cache (
        id TEXT PRIMARY KEY,
        tool_name TEXT,
        args TEXT,
        original_text TEXT,
        ranges TEXT,
        content_hash TEXT,
        created_at TEXT,
        last_accessed_at TEXT,
        size_bytes INTEGER
      );

      -- Learned protections: every sentence the brain model once reported missing from a
      -- shortened skill run, in normalised form. A line that contains one is protected by code from then
      -- on, so the same loss never recurs and the list grows without anyone editing patterns. Rows are
      -- never pruned automatically; "pnpm run protections -- --forget" removes one on purpose.
      CREATE TABLE IF NOT EXISTS distill_protect (
        pattern TEXT PRIMARY KEY,
        tool_name TEXT,
        hits INTEGER DEFAULT 1,
        first_seen TEXT,
        last_seen TEXT
      );

      -- Conditioning cache dependencies (used by decision memory and the repository index): the repository state a cached conditioning relied on.
      -- A hit is served only while every path still has this mtime and no expires_at has passed.
      -- Rows without dependencies (every row before this table) are served as before.
      CREATE TABLE IF NOT EXISTS condition_deps (
        key TEXT NOT NULL,
        path TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        expires_at TEXT,
        PRIMARY KEY (key, path)
      );

      -- Decision memory: one FTS5 index of every repo's .slm-gate/decisions files, keyed by
      -- repo root, plus the revision it was built from so it is rebuilt only when a file changed.
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(root UNINDEXED, path UNINDEXED, title, body, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS decisions_index (
        root TEXT PRIMARY KEY,
        revision TEXT NOT NULL
      );

      -- Repository symbol index (the repository index, REPO_INDEX=on): one FTS5 row per symbol, the mtime each file was
      -- indexed at, and a per-root revision that moves whenever a file changed (the cache dependency).
      CREATE TABLE IF NOT EXISTS repo_files (
        root TEXT NOT NULL,
        path TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        PRIMARY KEY (root, path)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS repo_fts USING fts5(root UNINDEXED, path UNINDEXED, line UNINDEXED, kind UNINDEXED, name, tokens, signature, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS repo_index (
        root TEXT PRIMARY KEY,
        revision INTEGER NOT NULL
      );

      -- Conversation memory (docs/briefs/2026-10-22-conversation-memory.md): one short running summary per
      -- conversation, folded by the model gate from the turns it sees, read by the local steps. The summary
      -- text lives ONLY here: never in events.meta (that is mirrored to Langfuse), never in logs.
      CREATE TABLE IF NOT EXISTS conversation_memory (
        key TEXT PRIMARY KEY,          -- conversation key (sha256 of the first user entry), plus ':<discriminator>' for a fork
        root TEXT,                     -- the workspace the conversation names, when the request says (slice 2)
        summary TEXT NOT NULL,         -- the running summary, under MEMORY_MAX_TOKENS
        turns INTEGER NOT NULL,        -- the cursor: history entries the summary has actually read
        discriminator TEXT,            -- sha256 of the second user entry, once there is one
        started_at TEXT NOT NULL,      -- when this conversation was first seen
        folded_at TEXT NOT NULL,       -- the last successful fold
        fold_failed_at TEXT,           -- the last failed fold; at or after folded_at means "unusable until a good fold"
        fold_count INTEGER NOT NULL DEFAULT 0,
        fold_ms INTEGER,               -- the last fold's duration
        prompt_version TEXT NOT NULL
      );
    `);


    // Additive, idempotent column migrations. CREATE TABLE IF NOT EXISTS above only covers
    // fresh databases, and this process runs headless inside MCP hosts where nobody will
    // remember to run scripts/migrations/*. Every column here must be nullable.
    for (const [table, column, ddl] of [
      ['events', 'provider', 'ALTER TABLE events ADD COLUMN provider TEXT'],
      ['events', 'agent', 'ALTER TABLE events ADD COLUMN agent TEXT'],
      ['events', 'environment', 'ALTER TABLE events ADD COLUMN environment TEXT'],
      ['langfuse_queue', 'attempts', 'ALTER TABLE langfuse_queue ADD COLUMN attempts INTEGER DEFAULT 0'],
      ['langfuse_queue', 'claimed_at', 'ALTER TABLE langfuse_queue ADD COLUMN claimed_at TEXT'],
    ] as const) {
      const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[] | undefined;
      if (!Array.isArray(tableInfo) || tableInfo.some(c => c.name === column)) continue;
      try {
        db.exec(ddl);
        log.info('ledger', `Migrated: added ${table}.${column}`);
      } catch (err) {
        // "duplicate column name" means another process won the race — benign.
        const message = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(message)) throw err;
      }
    }

    const policyCount = db.prepare('SELECT count(*) as c FROM distill_policy').get() as { c: number } | undefined;
    if (!policyCount || policyCount.c === 0) {
      const stmt = db.prepare('INSERT INTO distill_policy (tool_pattern, fidelity, priority, updated_at) VALUES (?, ?, ?, ?)');
      const now = new Date().toISOString();
      // Skills: these rows are the "off" default only. The DISTILL_SKILLS switch decides for every
      // skill payload (on → summarize under the fidelity guard); see distillToolResultWithStats.
      stmt.run('%skill%', 'verbatim', 10, now);
      stmt.run('get_skill', 'verbatim', 10, now);
      stmt.run('read_file', 'structural', 5, now);
      stmt.run('view_file', 'structural', 5, now);
      stmt.run('run_command', 'summarize', 0, now);
      stmt.run('get_logs', 'summarize', 0, now);
      stmt.run('grep_search', 'summarize', 0, now);
      stmt.run('list_dir', 'summarize', 0, now);
      stmt.run('*', 'summarize', -1, now);
    }

    // Automatic cleanup (startup sweep): every cached table loses what is older than ELISION_RETENTION_DAYS.
    // The semantic cache prunes itself when it is opened (src/cache/index.ts); events are never pruned.
    const retentionDays = CONFIG.ELISION_RETENTION_DAYS ?? 180;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const cutoff = cutoffDate.toISOString();
    db.prepare(`DELETE FROM elision_cache WHERE created_at < ?`).run(cutoff);
    db.prepare(`DELETE FROM cache WHERE ts < ?`).run(cutoff);
    db.prepare(`DELETE FROM llm_distilled WHERE created_at < ?`).run(cutoff);
  }
  return db;
}

/** Closes the connection at shutdown (src/shutdown.ts); a later getDb() would open the file again. */
export function closeDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

/** Test-only: drops the open connection so the next getDb() opens the configured file afresh. */
export function __resetDbForTests(): void {
  db = null;
}

/**
 * Log the resolved ledger database path and event count to stderr.
 * Call at startup from each layer entry point so divergent paths are immediately obvious.
 *
 * @param layer - Identifier for the calling layer (e.g. 'mcp-gate', 'llm-gate', 'sync')
 */
export function logLedgerInfo(layer: string): void {
  const database = getDb();
  const count = (database.prepare('SELECT count(*) as c FROM events').get() as { c: number })?.c ?? 0;
  const resolved = path.resolve(CONFIG.LEDGER_PATH);
  log.info(layer, `Using database: ${resolved} (${count} events)`);
}
