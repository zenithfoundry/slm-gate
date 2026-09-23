import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { waitWithBackoff } from '../utils/backoff.js';
import {
  getProviderRegistry,
  minutesFreed,
  providerFromAgentName,
  providerFromModelId,
  type MeteringModel,
} from '../pricing/providers.js';

let db: Database.Database | null = null;

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

export interface LedgerEvent {
  ts: string;
  layer: 'mcp' | 'llm';
  request_id: string;
  session_id?: string;
  skill?: string;
  route: 'defer_local' | 'escalate' | 'forward_compressed' | 'forward_raw' | 'condition' | 'feedback';
  is_local_call: number; // 0 or 1
  slm_model?: string;
  api_model?: string;
  in_tok: number;
  out_tok: number;
  api_in_tok: number;
  api_out_tok: number;
  cost_usd: number;
  slm_latency_s: number;
  api_latency_s: number;
  verifier_flags?: string; // JSON
  quality_score?: number | null;
  slm_gate: 'on' | 'off';
  meta?: string; // JSON
  agent?: string;
  provider?: string | null;
  /**
   * Langfuse environment dimension. Separates benchmark/harness runs from real traffic so
   * they can be filtered out of the dashboard. Defaults to CONFIG.LANGFUSE_ENVIRONMENT;
   * the harness sets 'bench'.
   */
  environment?: string | null;
}

import fs from 'node:fs';
import path from 'node:path';

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
      -- text the gate sent. The first decision wins and rows are never pruned automatically: every
      -- later request must resend the same bytes, or provider caches and Claude's thinking break.
      CREATE TABLE IF NOT EXISTS llm_distilled (
        key TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS langfuse_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT,
        synced INTEGER DEFAULT 0,
        attempts INTEGER DEFAULT 0
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
    `);


    // Additive, idempotent column migrations. CREATE TABLE IF NOT EXISTS above only covers
    // fresh databases, and this process runs headless inside MCP hosts where nobody will
    // remember to run scripts/migrations/*. Every column here must be nullable.
    for (const [table, column, ddl] of [
      ['events', 'provider', 'ALTER TABLE events ADD COLUMN provider TEXT'],
      ['events', 'agent', 'ALTER TABLE events ADD COLUMN agent TEXT'],
      ['events', 'environment', 'ALTER TABLE events ADD COLUMN environment TEXT'],
      ['langfuse_queue', 'attempts', 'ALTER TABLE langfuse_queue ADD COLUMN attempts INTEGER DEFAULT 0'],
    ] as const) {
      const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[] | undefined;
      if (!Array.isArray(tableInfo) || tableInfo.some(c => c.name === column)) continue;
      try {
        db.exec(ddl);
        console.error(`[ledger] Migrated: added ${table}.${column}`);
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

    // Automatic cleanup (startup sweep)
    const retentionDays = CONFIG.ELISION_RETENTION_DAYS ?? 180;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    db.prepare(`DELETE FROM elision_cache WHERE created_at < ?`).run(cutoffDate.toISOString());
  }
  return db;
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
  console.error(`[${layer}] Using database: ${resolved} (${count} events)`);
}

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

    db.prepare(`UPDATE elision_cache SET last_accessed_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
    return row;
  }
  
  return null;
}

export function isLocalEvent(e: LedgerEvent): boolean {
  return e.route === 'defer_local' || (!!e.verifier_flags && !e.verifier_flags.includes('escalate'));
}

export type RoutingOutcome = 'resolved_local' | 'distilled_forwarded' | 'escalated_cloud';

/**
 * Classifies what actually happened to a request.
 *
 * The previous binary (isLocalEvent) had no slot for `condition`, so every distilled MCP
 * tool result was labelled "Escalated (Cloud)" in the `verified` pie while the same trace
 * carried a `call:local` tag — the two widgets flatly contradicted each other. Distillation
 * is a third outcome: real local work was done, AND the payload still went to the cloud.
 *
 * @param e The ledger event to classify
 * @returns Which of the three routing outcomes occurred
 */
export function routingOutcome(e: LedgerEvent): RoutingOutcome {
  if (isLocalEvent(e)) return 'resolved_local';
  if (e.route === 'condition' || e.route === 'forward_compressed') return 'distilled_forwarded';
  return 'escalated_cloud';
}

// Detection is delegated to the data-driven provider registry so a new host or vendor is
// configuration (PROVIDER_REGISTRY_PATH), not a code change and a release.
export function providerFromModel(model?: string): 'claude' | 'chatgpt' | 'gemini' | null {
  return providerFromModelId(model) as 'claude' | 'chatgpt' | 'gemini' | null;
}

export function providerFromAgent(agent?: string): 'claude' | 'chatgpt' | 'gemini' | null {
  return providerFromAgentName(agent) as 'claude' | 'chatgpt' | 'gemini' | null;
}

/**
 * Resolves the provider for an event using every available signal, in priority order.
 *
 * @param e The ledger event
 * @returns Provider id, or null when the event cannot be attributed.
 */
export function resolveProvider(e: LedgerEvent): string | null {
  return e.provider ?? providerFromModelId(e.api_model) ?? providerFromAgentName(e.agent) ?? CONFIG.PROVIDER ?? null;
}

/**
 * Units of a provider's window that this single event frees.
 *
 * The unit depends on the metering model: requests never sent for 'message' providers,
 * tokens never sent for 'compute' providers. Returning units (not minutes) keeps this
 * honest — conversion to minutes requires a window budget the gate cannot observe.
 *
 * @param e The ledger event
 * @param metering How the provider meters its window
 * @returns Units saved, never negative.
 */
export function perEventUnitsSaved(e: LedgerEvent, metering: MeteringModel): number {
  if (metering === 'message') {
    // Only a prompt answered entirely locally avoids a request. A distilled-but-forwarded
    // payload still costs one message, no matter how much it was compressed.
    return e.route === 'defer_local' ? 1 : 0;
  }
  return perEventTokensSaved(e);
}

/**
 * Minutes of a provider's rolling window freed by a single event.
 *
 * @param e The ledger event
 * @param providerId Provider id, as resolved by resolveProvider()
 * @returns Minutes freed, clamped to [0, windowMinutes], or null when the provider is
 *   unknown or its window budget has not been configured.
 */
export function perEventCycleMinutes(e: LedgerEvent, providerId: string): number | null {
  const profile = getProviderRegistry()[providerId];
  if (!profile) return null;
  // No budget means no denominator. Emitting a number here is what produced the old
  // nonsense figures, so minutesFreed returns null instead.
  return minutesFreed(profile, perEventUnitsSaved(e, profile.metering));
}

export function perEventTokensSaved(e: LedgerEvent): number {
  // 'feedback' rows record a user action (an elision expansion), not model work.
  if (e.route === 'feedback') return 0;
  const parsedMeta = e.meta ? (() => { try { return JSON.parse(e.meta); } catch { return {}; } })() : {};
  if (e.route === 'defer_local') {
    return (e.in_tok || 0) + (e.out_tok || 0);
  } else if (e.route === 'forward_compressed') {
    const rawInTok = typeof parsedMeta.raw_in_tok === 'number' ? parsedMeta.raw_in_tok : (e.api_in_tok > 0 ? Math.round(e.api_in_tok * 1.5) : e.in_tok);
    const baselineTokens = rawInTok + (e.api_out_tok || e.out_tok || 0);
    const actualTokens = (e.api_in_tok || 0) + (e.api_out_tok || 0);
    return Math.max(0, baselineTokens - actualTokens);
  } else if (e.route === 'condition') {
    const baselineTokens = e.in_tok || 0;
    const actualTokens = e.out_tok || 0;
    return Math.max(0, baselineTokens - actualTokens);
  }
  return 0;
}

export function perEventBaselineTokens(e: LedgerEvent): number {
  if (e.route === 'feedback') return 0;
  const parsedMeta = e.meta ? (() => { try { return JSON.parse(e.meta); } catch { return {}; } })() : {};
  if (e.route === 'defer_local') {
    return (e.in_tok || 0) + (e.out_tok || 0);
  } else if (e.route === 'forward_compressed') {
    const rawInTok = typeof parsedMeta.raw_in_tok === 'number' ? parsedMeta.raw_in_tok : (e.api_in_tok > 0 ? Math.round(e.api_in_tok * 1.5) : e.in_tok);
    return rawInTok + (e.api_out_tok || e.out_tok || 0);
  } else if (e.route === 'condition') {
    return e.in_tok || 0;
  }
  return (e.api_in_tok || e.in_tok || 0) + (e.api_out_tok || e.out_tok || 0);
}

export function computeTotals(rows: LedgerEvent[]) {
  let tokensSaved = 0;
  let baselineTokens = 0;
  
  for (const r of rows) {
    baselineTokens += perEventBaselineTokens(r);
    tokensSaved += perEventTokensSaved(r);
  }
  
  return { tokensSaved, baselineTokens };
}

export function computeTotalsByProvider(
  rows: LedgerEvent[],
  fallbackProvider: 'claude' | 'chatgpt' | 'gemini' | null = CONFIG.PROVIDER ?? null
) {
  const stats = {
    claude: { tokensSaved: 0, baselineTokens: 0 },
    chatgpt: { tokensSaved: 0, baselineTokens: 0 },
    gemini: { tokensSaved: 0, baselineTokens: 0 },
  };
  for (const r of rows) {
    const p = r.provider || providerFromModel(r.api_model) || providerFromAgent(r.agent) || fallbackProvider || null;
    if (p && stats[p as keyof typeof stats]) {
      stats[p as keyof typeof stats].baselineTokens += perEventBaselineTokens(r);
      stats[p as keyof typeof stats].tokensSaved += perEventTokensSaved(r);
    }
  }
  return stats;
}

export function computeCycleRates(
  rows: LedgerEvent[],
  // Same default as computeCycleRateAvg. Without it, an event carrying no provider was
  // attributed by the average but not by the total, so the two disagreed on the same data.
  fallbackProvider: 'claude' | 'chatgpt' | 'gemini' | null = CONFIG.PROVIDER ?? null
): Record<'claude'|'chatgpt'|'gemini', number> {
  // Aggregate minutes freed across all of a provider's traffic. Uses the same rate-based
  // definition as the per-event score, so the two can never disagree.
  const out: any = { claude: 0, chatgpt: 0, gemini: 0 };
  for (const r of rows) {
    const p = (r.provider || providerFromModel(r.api_model) || providerFromAgent(r.agent) || fallbackProvider || null);
    if (p && p in out) {
      out[p] += perEventCycleMinutes(r, p) ?? 0;
    }
  }
  for (const p of Object.keys(out)) out[p] = Number(out[p].toFixed(2));
  return out;
}

export function computeCycleRateAvg(
  rows: LedgerEvent[],
  fallbackProvider: 'claude' | 'chatgpt' | 'gemini' | null = CONFIG.PROVIDER ?? null
): Record<'claude' | 'chatgpt' | 'gemini', number | null> {
  const counts: Record<'claude' | 'chatgpt' | 'gemini', number> = { claude: 0, chatgpt: 0, gemini: 0 };
  const sums: Record<'claude' | 'chatgpt' | 'gemini', number> = { claude: 0, chatgpt: 0, gemini: 0 };

  for (const r of rows) {
    const p = (r.provider || providerFromModel(r.api_model) || providerFromAgent(r.agent) || fallbackProvider || null) as 'claude' | 'chatgpt' | 'gemini' | null;
    if (p && (p === 'claude' || p === 'chatgpt' || p === 'gemini')) {
      // null means the provider has no configured window budget, so this event contributes
      // nothing and is excluded from the denominator too — an unmeasurable event must not
      // be averaged in as a zero.
      const minutes = perEventCycleMinutes(r, p);
      if (minutes !== null) {
        sums[p] += minutes;
        counts[p] += 1;
      }
    }
  }

  return {
    claude: counts.claude > 0 ? sums.claude / counts.claude : null,
    chatgpt: counts.chatgpt > 0 ? sums.chatgpt / counts.chatgpt : null,
    gemini: counts.gemini > 0 ? sums.gemini / counts.gemini : null,
  };
}

export function writeEvent(e: LedgerEvent) {
  // Resolve derived fields ONCE and carry them on a single enriched object, so SQLite and
  // Langfuse can never disagree. Previously `provider` was computed into a local, written
  // to SQLite, and then the *un-enriched* `e` was mirrored — leaving Langfuse to re-derive
  // it through a chain ending in CONFIG.PROVIDER, which is unset when .env fails to load.
  const event: LedgerEvent = {
    ...e,
    provider: e.provider ?? providerFromModel(e.api_model) ?? providerFromAgent(e.agent) ?? CONFIG.PROVIDER ?? null,
    environment: e.environment ?? CONFIG.LANGFUSE_ENVIRONMENT,
  };

  const statement = getDb().prepare(`
    INSERT OR REPLACE INTO events (
      ts, layer, request_id, session_id, skill, route, is_local_call, slm_model, api_model,
      in_tok, out_tok, api_in_tok, api_out_tok, cost_usd, slm_latency_s, api_latency_s,
      verifier_flags, quality_score, slm_gate, meta, provider, agent, environment
    ) VALUES (
      @ts, @layer, @request_id, @session_id, @skill, @route, @is_local_call, @slm_model, @api_model,
      @in_tok, @out_tok, @api_in_tok, @api_out_tok, @cost_usd, @slm_latency_s, @api_latency_s,
      @verifier_flags, @quality_score, @slm_gate, @meta, @provider, @agent, @environment
    )
  `);

  // better-sqlite3 strictly requires all named parameters to exist on the object,
  // so we must coalesce any undefined optional properties to null.
  statement.run({
    ts: event.ts,
    layer: event.layer,
    request_id: event.request_id,
    session_id: event.session_id ?? null,
    skill: event.skill ?? null,
    route: event.route,
    is_local_call: event.is_local_call,
    slm_model: event.slm_model ?? null,
    api_model: event.api_model ?? null,
    in_tok: event.in_tok,
    out_tok: event.out_tok,
    api_in_tok: event.api_in_tok,
    api_out_tok: event.api_out_tok,
    cost_usd: event.cost_usd,
    slm_latency_s: event.slm_latency_s,
    api_latency_s: event.api_latency_s,
    verifier_flags: event.verifier_flags ?? null,
    quality_score: event.quality_score ?? null,
    slm_gate: event.slm_gate,
    meta: event.meta ?? null,
    provider: event.provider,
    agent: event.agent ?? null,
    environment: event.environment ?? null
  });

  // Mirror to Langfuse if enabled
  LangfuseSink.mirrorEvent(event);
}

export function cacheGet(key: string): string | null {
  const statement = getDb().prepare('SELECT value FROM cache WHERE key = ?');
  const row = statement.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function cacheSet(key: string, value: string) {
  const statement = getDb().prepare('INSERT OR REPLACE INTO cache (key, value, ts) VALUES (?, ?, ?)');
  statement.run(key, value, new Date().toISOString());
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

import { safeCalculateCostUsd } from '../pricing/index.js';

export interface LangfuseGenerationPayload {
  id?: string;
  name: string;
  model: string;
  usageDetails: {
    input?: number;
    output?: number;
    total?: number;
  };
  costDetails?: {
    total: number;
    input?: number;
    output?: number;
  };
  startTime: string;
  endTime: string;
  environment?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LangfuseScorePayload {
  id?: string;
  name: string;
  value: number | string;
  comment?: string;
  environment?: string | null;
  dataType?: 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL';
}

export interface LangfuseQueuePayload {
  /**
   * The originating event's timestamp. Langfuse stamps each ingestion envelope, not the
   * body, so this must be carried through the queue and applied to every envelope at
   * flush time — otherwise all history collapses onto whenever the flush happened and
   * every date-windowed widget breaks.
   */
  eventTs?: string;
  /** Langfuse environment dimension, applied to trace, generation and score bodies. */
  environment?: string | null;
  trace: {
    id: string;
    timestamp?: string;
    environment?: string | null;
    sessionId?: string | null;
    tags: string[];
    metadata?: Record<string, unknown>;
    name: string;
  };
  generations?: LangfuseGenerationPayload[];
  generation?: LangfuseGenerationPayload; // legacy single generation support
  span?: {
    name: string;
    startTime: string;
    endTime: string;
    metadata: {
      model: string;
      usage?: {
        input: number;
        output: number;
      };
      cost_usd: number;
    };
  };
  scores?: LangfuseScorePayload[];
}

/**
 * Carried by every trace the gate writes. Other programs may write to the same Langfuse
 * project, so ledger:verify counts and langfuse:wipe deletes only traces with this tag. The
 * dashboard cards do not use it (see setup-dashboard.ts): they filter on the gate's score names.
 */
export const SLM_GATE_SOURCE_TAG = 'source:slm-gate';

export function formatEventForLangfuse(e: LedgerEvent): LangfuseQueuePayload {
  // Price against the model that actually served (or would have served) this event.
  // Previously every defer_local/condition event was priced at CONFIG.CLOUD_MODEL, so
  // Claude traffic was costed at Gemini rates — and because CLOUD_MODEL comes from .env,
  // the figure silently changed depending on which directory the gate was spawned in.
  const referenceCloudModel = e.api_model || CONFIG.CLOUD_MODEL || 'gemini-2.5-flash';
  
  const baselineTokens = perEventBaselineTokens(e);
  const tokensSaved = perEventTokensSaved(e);
  let baselineCostUsd = 0;
  let costSavedUsd = 0;
  
  const parsedMeta = e.meta ? (() => { try { return JSON.parse(e.meta); } catch { return {}; } })() : {};
  
  if (e.route === 'defer_local') {
    baselineCostUsd = safeCalculateCostUsd(referenceCloudModel, e.in_tok, e.out_tok);
    costSavedUsd = baselineCostUsd;
  } else if (e.route === 'forward_compressed') {
    const rawInTok = typeof parsedMeta.raw_in_tok === 'number' ? parsedMeta.raw_in_tok : (e.api_in_tok > 0 ? Math.round(e.api_in_tok * 1.5) : e.in_tok);
    baselineCostUsd = safeCalculateCostUsd(referenceCloudModel, rawInTok, e.api_out_tok || e.out_tok || 0);
    costSavedUsd = Math.max(0, baselineCostUsd - (e.cost_usd || 0));
  } else if (e.route === 'condition') {
    baselineCostUsd = safeCalculateCostUsd(referenceCloudModel, baselineTokens, 0);
    const conditionedCostUsd = safeCalculateCostUsd(referenceCloudModel, e.out_tok || 0, 0);
    costSavedUsd = Math.max(0, baselineCostUsd - conditionedCostUsd);
  } else {
    // forward_raw or escalate
    baselineCostUsd = e.cost_usd || 0;
    costSavedUsd = 0;
  }

  const traceName = e.skill 
    ? e.skill 
    : (e.layer === 'mcp' ? `[mcp] ${e.route}` : `[llm] ${e.route}`);

  const tags = [
    SLM_GATE_SOURCE_TAG,
    e.slm_gate === 'on' ? 'slm_gate=on' : 'slm_gate=off',
    `route:${e.route}`,
    `layer:${e.layer}`,
    `call:${routingOutcome(e) === 'resolved_local' ? 'local' : 'cloud'}`,
    `outcome:${routingOutcome(e)}`,
    `model:${e.api_model || e.slm_model || 'unknown'}`
  ];

  const metadata: Record<string, unknown> = {
    ...parsedMeta,
    route: e.route,
    layer: e.layer,
    is_local_call: Boolean(e.is_local_call),
    slm_model: e.slm_model ?? undefined,
    api_model: e.api_model ?? undefined,
    slm_latency_s: e.slm_latency_s,
    api_latency_s: e.api_latency_s,
    cost_usd: e.cost_usd,
    baseline_tokens: baselineTokens,
    baseline_cost_usd: Number(baselineCostUsd.toFixed(6)),
    tokens_saved: tokensSaved,
    cost_saved_usd: Number(costSavedUsd.toFixed(6)),
    verifier_flags: e.verifier_flags ? (() => { try { return JSON.parse(e.verifier_flags); } catch { return e.verifier_flags; } })() : undefined,
  };

  const generations: LangfuseGenerationPayload[] = [];

  // Cloud generation
  if (e.api_model && (e.api_in_tok > 0 || e.api_out_tok > 0)) {
    const apiLatency = e.api_latency_s > 0 ? e.api_latency_s : 0.05;
    generations.push({
      id: `${e.request_id}_gen_cloud`,
      name: 'cloud_api_call',
      model: e.api_model,
      usageDetails: {
        input: e.api_in_tok,
        output: e.api_out_tok,
        total: e.api_in_tok + e.api_out_tok,
      },
      costDetails: {
        total: e.cost_usd,
      },
      startTime: new Date(new Date(e.ts).getTime() - apiLatency * 1000).toISOString(),
      endTime: new Date(e.ts).toISOString(),
      metadata: {
        cost_usd: e.cost_usd,
        route: e.route,
      }
    });
  }

  // Local SLM generation (logged as generation so Langfuse aggregates local token throughput at $0)
  if (e.slm_model && (e.in_tok > 0 || e.out_tok > 0)) {
    const slmLatency = e.slm_latency_s > 0 ? e.slm_latency_s : 0.05;
    const apiLatency = e.api_latency_s || 0;
    generations.push({
      id: `${e.request_id}_gen_local`,
      name: 'local_slm_generation',
      model: e.slm_model,
      usageDetails: {
        input: e.in_tok,
        output: e.out_tok,
        total: e.in_tok + e.out_tok,
      },
      costDetails: {
        total: 0,
      },
      startTime: new Date(new Date(e.ts).getTime() - (apiLatency + slmLatency) * 1000).toISOString(),
      endTime: new Date(new Date(e.ts).getTime() - apiLatency * 1000).toISOString(),
      metadata: {
        cost_usd: 0,
        route: e.route,
      }
    });
  }

  const scores: LangfuseScorePayload[] = [
    { id: `${e.request_id}_score_cost_saved`, name: 'cost_saved_cents', value: Number((costSavedUsd * 100).toFixed(6)), dataType: 'NUMERIC' },
    { id: `${e.request_id}_score_tokens_saved`, name: 'tokens_saved', value: tokensSaved, dataType: 'NUMERIC' },
  ];

  // Accuracy rule
  if (typeof e.quality_score === 'number') {
    scores.push({ id: `${e.request_id}_score_accuracy_rate_pct`, name: 'accuracy_rate_pct', value: Number((e.quality_score * 100).toFixed(2)), dataType: 'NUMERIC' });
  } else {
    // Only score accuracy when a verifier ACTUALLY RAN. Previously `route === 'condition'`
    // and `is_local_call === 1` both forced isAccepted true, so every MCP event scored a
    // free 100 and the "SLM Accuracy Rate" widget measured nothing at all. The MCP path
    // never invokes the verifier (src/verifier is only called from llm-gate/pipeline.ts),
    // so those events must now produce NO accuracy score rather than a fake perfect one.
    const localAttempted = parsedMeta.local_attempted === 1;
    if (localAttempted) {
      let hasFailureFlag = false;
      if (e.verifier_flags) {
        try {
          const flags = JSON.parse(e.verifier_flags);
          hasFailureFlag = Array.isArray(flags) && flags.length > 0;
        } catch {
          hasFailureFlag = Boolean(e.verifier_flags);
        }
      }
      const isAccepted = parsedMeta.local_accepted === 1 || !hasFailureFlag;
      scores.push({ id: `${e.request_id}_score_accuracy_rate_pct`, name: 'accuracy_rate_pct', value: isAccepted ? 100 : 0, dataType: 'NUMERIC' });
    }
  }

  const outcome = routingOutcome(e);
  const verifiedLabels: Record<RoutingOutcome, { label: string; comment: string }> = {
    resolved_local: {
      label: 'Passed (Local SLM)',
      comment: 'Handled 100% locally by Small Language Model ($0 cloud cost)'
    },
    distilled_forwarded: {
      label: 'Distilled (Forwarded)',
      comment: 'Compressed locally by the SLM, then forwarded to the cloud model'
    },
    escalated_cloud: {
      label: 'Escalated (Cloud)',
      comment: 'Sent to the cloud model without local resolution'
    }
  };
  scores.push({
    id: `${e.request_id}_score_verified`,
    name: 'verified',
    value: verifiedLabels[outcome].label,
    dataType: 'CATEGORICAL',
    comment: verifiedLabels[outcome].comment
  });

  const resolvedProvider = resolveProvider(e);
  if (resolvedProvider) {
    const cycleMinutes = perEventCycleMinutes(e, resolvedProvider);
    // Emitted only when the provider's window budget is configured. Without a denominator
    // there is no honest way to express savings as minutes, so we stay silent rather than
    // publishing the old ratio-times-window figure.
    if (cycleMinutes !== null) {
      // The same quantity in two units. A Langfuse widget picks a measure and an
      // aggregation and cannot convert, so a card that reads in minutes needs a score in
      // minutes. Minutes carry the raw value and are summed into a per-range total;
      // seconds are averaged into a per-prompt figure, where minutes render as an
      // unreadable 0.18934.
      scores.push({
        id: `${e.request_id}_score_cycle_min_${resolvedProvider}`,
        name: `cycle_extended_minutes_${resolvedProvider}`,
        value: cycleMinutes,
        dataType: 'NUMERIC'
      });
      scores.push({
        id: `${e.request_id}_score_cycle_sec_${resolvedProvider}`,
        name: `cycle_extended_seconds_${resolvedProvider}`,
        value: Number((cycleMinutes * 60).toFixed(1)),
        dataType: 'NUMERIC'
      });
    }
  }

  const environment = e.environment ?? CONFIG.LANGFUSE_ENVIRONMENT;
  const eventTs = new Date(e.ts).toISOString();

  return {
    eventTs,
    environment,
    trace: {
      id: e.request_id,
      // TraceBody supports `timestamp` directly; ScoreBody does not, so scores rely on the
      // ingestion envelope instead (see flushQueue / sync.ts).
      timestamp: eventTs,
      environment,
      sessionId: e.session_id,
      tags,
      metadata,
      name: traceName,
    },
    generations: generations.map(g => ({ ...g, environment })),
    scores: scores.map(s => ({ ...s, environment })),
  };
}

/** One rejected item from a Langfuse ingestion response (the `errors` array of a 207). */
interface IngestionItemError {
  id?: string;
  status?: number;
  message?: string;
  error?: unknown;
}

/** Flushes a queue row may be rejected before it is parked in langfuse_dead_letter. */
const MAX_ROW_ATTEMPTS = 5;

function describeItemError(e: IngestionItemError): string {
  const detail = e.message ?? (typeof e.error === 'string' ? e.error : e.error === undefined ? '' : JSON.stringify(e.error));
  return `status=${e.status ?? 'unknown'} ${detail}`.trim();
}

export class LangfuseSink {
  static _warnedMissingKeys = false;
  
  static hasValidConfig(): boolean {
    const hasKeys = CONFIG.LANGFUSE_PUBLIC_KEY || CONFIG.LANGFUSE_SECRET_KEY || CONFIG.LANGFUSE_HOST;
    const hasAllKeys = CONFIG.LANGFUSE_PUBLIC_KEY && CONFIG.LANGFUSE_SECRET_KEY && CONFIG.LANGFUSE_HOST;
    
    if (hasAllKeys) {
      return true;
    } else if (hasKeys && !this._warnedMissingKeys) {
      console.error('Langfuse needs LANGFUSE_PUBLIC_KEY + SECRET_KEY + HOST — running ledger-only');
      this._warnedMissingKeys = true;
    }
    return false;
  }

  static mirrorEvent(e: LedgerEvent) {
    try {
      const payload = formatEventForLangfuse(e);
      const statement = getDb().prepare('INSERT INTO langfuse_queue (payload) VALUES (?)');
      statement.run(JSON.stringify(payload));
    } catch (err) {
      console.error('Failed to queue langfuse event:', err);
    }
  }

  /**
   * Ship queued Langfuse payloads.
   *
   * Drains to empty rather than a single fixed-size page: the previous `LIMIT 50` with no
   * loop meant throughput was capped at 50 events per invocation, so a backlog could never
   * catch up. Rows are only deleted after the server accepts them, so a failure leaves the
   * queue intact and the offline contract holds.
   *
   * Langfuse answers 207 when it takes the batch but rejects single items. A row is deleted
   * only when every one of its items was accepted; a rejected row stays queued with its
   * attempt count raised, and after MAX_ROW_ATTEMPTS it moves to langfuse_dead_letter so it
   * cannot block the queue. Each row is sent at most once per call, so a rejection costs one
   * attempt per flush, not one per batch.
   *
   * @param options.maxBatches Safety valve so a pathological queue cannot spin forever.
   * @param options.deadlineMs Wall-clock budget; used by the shutdown drain, where MCP hosts
   *   force-kill after a short grace period.
   * @returns Number of queue rows successfully shipped.
   */
  static async flushQueue(options: { maxBatches?: number; deadlineMs?: number } = {}): Promise<number> {
    if (!this.hasValidConfig()) return 0;

    const { maxBatches = 100, deadlineMs } = options;
    const startedAt = Date.now();
    const db = getDb();
    const MAX_ATTEMPTS = 3;
    let shipped = 0;
    // Rows at or below this id were already sent during this call.
    let lastId = 0;

    for (let batchNo = 0; batchNo < maxBatches; batchNo++) {
      if (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs) {
        console.error('[ledger] Langfuse flush hit its time budget; remaining rows stay queued.');
        break;
      }

      // ORDER BY id so the oldest events drain first and ordering is deterministic.
      const rows = db
        .prepare('SELECT id, payload, attempts FROM langfuse_queue WHERE synced = 0 AND id > ? ORDER BY id ASC LIMIT 50')
        .all(lastId) as { id: number; payload: string; attempts: number | null }[];

      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id;

      const batch: Array<{ id: string; type: string; timestamp: string; body: unknown }> = [];
      const rowIds = [];
      // Each batch item's id → the queue row it came from, so a per-item error in a 207
      // response can be traced back to the one row that must stay queued.
      const rowIdByItemId = new Map<string, number>();

      for (const row of rows) {
        rowIds.push(row.id);
        const payload = JSON.parse(row.payload) as LangfuseQueuePayload;

        // Langfuse stamps the ingestion ENVELOPE, not the body. ScoreBody has no timestamp
        // field at all, so without this every score lands at flush time and the whole time
        // series collapses onto a few instants — which is what broke the date filters.
        const envelopeTs = payload.eventTs ?? payload.trace?.timestamp ?? new Date().toISOString();
        const add = (item: { type: string; body: unknown }) => {
          const id = crypto.randomUUID();
          rowIdByItemId.set(id, row.id);
          batch.push({ id, type: item.type, timestamp: envelopeTs, body: item.body });
        };

        add({ type: 'trace-create', body: payload.trace });

        const generations = payload.generations || (payload.generation ? [payload.generation] : []);
        for (const gen of generations) {
          add({ type: 'generation-create', body: { ...gen, traceId: payload.trace.id } });
        }

        if (payload.scores && Array.isArray(payload.scores)) {
          for (const score of payload.scores) {
            add({ type: 'score-create', body: { ...score, traceId: payload.trace.id } });
          }
        }

        if (payload.span) {
          add({ type: 'span-create', body: { ...payload.span, traceId: payload.trace.id } });
        }
      }

      let accepted = false;
      let itemErrors: IngestionItemError[] = [];
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !accepted; attempt++) {
        try {
          const auth = Buffer.from(`${CONFIG.LANGFUSE_PUBLIC_KEY}:${CONFIG.LANGFUSE_SECRET_KEY}`).toString('base64');
          const res = await fetch(`${CONFIG.LANGFUSE_HOST}/api/public/ingestion`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ batch })
          });

          let body: { errors?: IngestionItemError[] } | null = null;
          try {
            body = await res.json() as { errors?: IngestionItemError[] };
          } catch { /* not JSON */ }

          if (body && Array.isArray(body.errors) && body.errors.length > 0) {
            for (const e of body.errors) {
              console.error(`[ledger] Langfuse per-item error: id=${e.id ?? 'unknown'} ${describeItemError(e)}`);
            }
          }

          if (res.ok) {
            accepted = true;
            itemErrors = body && Array.isArray(body.errors) ? body.errors : [];
            break;
          }

          // 429 and 5xx are transient: back off and retry the same batch. Anything else is
          // a permanent rejection (bad payload, bad auth) that retrying cannot fix.
          const isTransient = res.status === 429 || res.status >= 500;
          const errText = body ? JSON.stringify(body) : await res.text().catch(() => '(no body)');
          if (!isTransient) {
            console.warn(`[ledger] Warning: Langfuse ingestion rejected (${res.status}): ${errText}`);
            break;
          }
          if (attempt < MAX_ATTEMPTS - 1) {
            await waitWithBackoff(attempt, MAX_ATTEMPTS, `Langfuse ingestion ${res.status}`, res.headers.get('retry-after'), 'ledger');
          } else {
            console.warn(`[ledger] Warning: Langfuse ingestion failed after ${MAX_ATTEMPTS} attempts (${res.status}): ${errText}`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt < MAX_ATTEMPTS - 1) {
            await waitWithBackoff(attempt, MAX_ATTEMPTS, `Langfuse network error (${message})`, null, 'ledger');
          } else {
            console.warn(`[ledger] Warning: Langfuse network flush failed: ${message}`);
          }
        }
      }

      if (!accepted) break; // leave rows queued for the next attempt

      // An error that names no item of this batch cannot be pinned to a row, so every row
      // in the batch is treated as rejected: resending is harmless (every id is an upsert),
      // deleting an unaccepted row is silent data loss.
      const rejections = new Map<number, string[]>();
      for (const e of itemErrors) {
        const rowId = e.id === undefined ? undefined : rowIdByItemId.get(e.id);
        for (const id of rowId === undefined ? rowIds : [rowId]) {
          rejections.set(id, [...(rejections.get(id) ?? []), describeItemError(e)]);
        }
      }

      const acceptedIds = rowIds.filter(id => !rejections.has(id));
      db.transaction(() => {
        if (acceptedIds.length > 0) {
          const placeholders = acceptedIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM langfuse_queue WHERE id IN (${placeholders})`).run(...acceptedIds);
        }
        for (const row of rows) {
          const errors = rejections.get(row.id);
          if (!errors) continue;
          const attempts = (row.attempts ?? 0) + 1;
          if (attempts < MAX_ROW_ATTEMPTS) {
            db.prepare('UPDATE langfuse_queue SET attempts = ? WHERE id = ?').run(attempts, row.id);
            continue;
          }
          db.prepare('INSERT OR REPLACE INTO langfuse_dead_letter (id, payload, attempts, error, dead_at) VALUES (?, ?, ?, ?, ?)')
            .run(row.id, row.payload, attempts, errors.join('\n'), new Date().toISOString());
          db.prepare('DELETE FROM langfuse_queue WHERE id = ?').run(row.id);
          console.warn(`[ledger] Warning: Langfuse rejected queue row ${row.id} ${attempts} times; moved it to langfuse_dead_letter. Last error: ${errors[0]}`);
        }
      })();
      shipped += acceptedIds.length;
    }

    return shipped;
  }

  /**
   * Test-only utility to reset the internal client state.
   */
  static __resetForTests() {
    db = null;
  }
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

export function getDistillPolicy(toolName: string): string {
  const db = getDb();
  if (!db) return 'summarize';
  try {
    const rows = db.prepare('SELECT tool_pattern, fidelity FROM distill_policy ORDER BY priority DESC').all() as any[];
    for (const r of rows) {
      if (r.tool_pattern === '*') return r.fidelity;
      const regexStr = r.tool_pattern.replace(/%/g, '.*');
      if (new RegExp('^' + regexStr + '$', 'i').test(toolName)) return r.fidelity;
    }
  } catch (e) {}
  return 'summarize';
}
