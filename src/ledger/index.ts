import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { waitWithBackoff } from '../utils/backoff.js';

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
  route: 'defer_local' | 'escalate' | 'forward_compressed' | 'forward_raw' | 'condition';
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
    const ledgerPath = CONFIG.LEDGER_PATH || './output/ledger.sqlite';
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

      CREATE TABLE IF NOT EXISTS langfuse_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT,
        synced INTEGER DEFAULT 0
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
    const tableInfo = db.prepare('PRAGMA table_info(events)').all() as { name: string }[] | undefined;
    if (Array.isArray(tableInfo)) {
      const eventColumns = new Set(tableInfo.map(c => c.name));
      for (const [column, ddl] of [
        ['provider', 'ALTER TABLE events ADD COLUMN provider TEXT'],
        ['agent', 'ALTER TABLE events ADD COLUMN agent TEXT'],
        ['environment', 'ALTER TABLE events ADD COLUMN environment TEXT'],
      ] as const) {
        if (eventColumns.has(column)) continue;
        try {
          db.exec(ddl);
          console.error(`[ledger] Migrated: added events.${column}`);
        } catch (err) {
          // "duplicate column name" means another process won the race — benign.
          const message = err instanceof Error ? err.message : String(err);
          if (!/duplicate column name/i.test(message)) throw err;
        }
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

export function providerFromModel(model?: string): 'claude' | 'chatgpt' | 'gemini' | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku') || m.includes('anthropic')) return 'claude';
  if (m.includes('gemini') || m.includes('gemma') || m.includes('bison')) return 'gemini';
  if (m.includes('gpt') || m.includes('openai') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'chatgpt';
  return null;
}

export function providerFromAgent(agent?: string): 'claude' | 'chatgpt' | 'gemini' | null {
  if (!agent) return null;
  const a = agent.toLowerCase();
  if (a.includes('antigravity')) return 'gemini';
  if (a.includes('claude')) return 'claude';
  if (a.includes('chatgpt') || a.includes('openai')) return 'chatgpt';
  return null;
}

export function perEventTokensSaved(e: LedgerEvent): number {
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
  fallbackProvider?: 'claude' | 'chatgpt' | 'gemini' | null
): Record<'claude'|'chatgpt'|'gemini', number> {
  const s = computeTotalsByProvider(rows, fallbackProvider);
  const plans = {
    claude: CONFIG.RESOLVED_PLAN_CLAUDE,
    chatgpt: CONFIG.RESOLVED_PLAN_CHATGPT,
    gemini: CONFIG.RESOLVED_PLAN_GEMINI
  };
  const out: any = { claude: 0, chatgpt: 0, gemini: 0 };
  for (const p of ['claude', 'chatgpt', 'gemini'] as const) {
    const t = s[p];
    out[p] = t.baselineTokens > 0 ? Number((plans[p].windowMinutes * (t.tokensSaved / t.baselineTokens)).toFixed(2)) : 0;
  }
  return out;
}

export function computeCycleRateAvg(
  rows: LedgerEvent[],
  fallbackProvider: 'claude' | 'chatgpt' | 'gemini' | null = CONFIG.PROVIDER ?? null
): Record<'claude' | 'chatgpt' | 'gemini', number | null> {
  const plans = {
    claude: CONFIG.RESOLVED_PLAN_CLAUDE,
    chatgpt: CONFIG.RESOLVED_PLAN_CHATGPT,
    gemini: CONFIG.RESOLVED_PLAN_GEMINI
  };
  const counts: Record<'claude' | 'chatgpt' | 'gemini', number> = { claude: 0, chatgpt: 0, gemini: 0 };
  const sums: Record<'claude' | 'chatgpt' | 'gemini', number> = { claude: 0, chatgpt: 0, gemini: 0 };

  for (const r of rows) {
    const p = (r.provider || providerFromModel(r.api_model) || providerFromAgent(r.agent) || fallbackProvider || null) as 'claude' | 'chatgpt' | 'gemini' | null;
    if (p && (p === 'claude' || p === 'chatgpt' || p === 'gemini')) {
      const baseline = perEventBaselineTokens(r);
      if (baseline > 0) {
        const saved = perEventTokensSaved(r);
        const wm = plans[p].windowMinutes;
        const val = wm * (saved / baseline);
        sums[p] += val;
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

export function formatEventForLangfuse(e: LedgerEvent): LangfuseQueuePayload {
  const referenceCloudModel = CONFIG.CLOUD_MODEL || 'gemini-2.5-flash';
  
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
    baselineCostUsd = safeCalculateCostUsd(e.api_model || referenceCloudModel, rawInTok, e.api_out_tok || e.out_tok || 0);
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
    e.slm_gate === 'on' ? 'slm_gate=on' : 'slm_gate=off',
    `route:${e.route}`,
    `layer:${e.layer}`,
    `call:${e.is_local_call ? 'local' : 'cloud'}`,
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
    const isLocalAttempted = parsedMeta.local_attempted === 1 || e.route === 'defer_local' || e.route === 'condition' || e.is_local_call === 1;
    if (isLocalAttempted) {
      let hasFailureFlag = false;
      if (e.verifier_flags) {
        try {
          const flags = JSON.parse(e.verifier_flags);
          hasFailureFlag = Array.isArray(flags) && flags.length > 0;
        } catch {
          hasFailureFlag = Boolean(e.verifier_flags);
        }
      }
      const isAccepted = parsedMeta.local_accepted === 1 || e.route === 'defer_local' || e.route === 'condition' || (e.is_local_call === 1 && !hasFailureFlag);
      scores.push({ id: `${e.request_id}_score_accuracy_rate_pct`, name: 'accuracy_rate_pct', value: isAccepted ? 100 : 0, dataType: 'NUMERIC' });
    }
  }

  const isLocal = isLocalEvent(e);
  const verifiedLabel = isLocal ? 'Passed (Local SLM)' : 'Escalated (Cloud)';
  const verifiedComment = isLocal
    ? 'Handled 100% locally by Small Language Model ($0 cloud cost)'
    : 'Distilled by SLM and escalated to Cloud model';
  scores.push({
    id: `${e.request_id}_score_verified`,
    name: 'verified',
    value: verifiedLabel,
    dataType: 'CATEGORICAL',
    comment: verifiedComment
  });

  const resolvedProvider = (e.provider ?? providerFromModel(e.api_model) ?? providerFromAgent(e.agent) ?? CONFIG.PROVIDER ?? null) as 'claude' | 'chatgpt' | 'gemini' | null;
  if (resolvedProvider && (resolvedProvider === 'claude' || resolvedProvider === 'chatgpt' || resolvedProvider === 'gemini') && baselineTokens > 0) {
    const plans = {
      claude: CONFIG.RESOLVED_PLAN_CLAUDE,
      chatgpt: CONFIG.RESOLVED_PLAN_CHATGPT,
      gemini: CONFIG.RESOLVED_PLAN_GEMINI
    };
    const wm = plans[resolvedProvider].windowMinutes;
    const value = wm * (tokensSaved / baselineTokens);
    scores.push({
      id: `${e.request_id}_score_cycle_${resolvedProvider}`,
      name: `cycle_extended_per_window_${resolvedProvider}`,
      value,
      dataType: 'NUMERIC'
    });
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

    for (let batchNo = 0; batchNo < maxBatches; batchNo++) {
      if (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs) {
        console.error('[ledger] Langfuse flush hit its time budget; remaining rows stay queued.');
        break;
      }

      // ORDER BY id so the oldest events drain first and ordering is deterministic.
      const rows = db
        .prepare('SELECT id, payload FROM langfuse_queue WHERE synced = 0 ORDER BY id ASC LIMIT 50')
        .all() as { id: number; payload: string }[];

      if (rows.length === 0) break;

      const batch = [];
      const rowIds = [];

      for (const row of rows) {
        rowIds.push(row.id);
        const payload = JSON.parse(row.payload) as LangfuseQueuePayload;

        // Langfuse stamps the ingestion ENVELOPE, not the body. ScoreBody has no timestamp
        // field at all, so without this every score lands at flush time and the whole time
        // series collapses onto a few instants — which is what broke the date filters.
        const envelopeTs = payload.eventTs ?? payload.trace?.timestamp ?? new Date().toISOString();

        batch.push({
          id: crypto.randomUUID(),
          type: 'trace-create',
          timestamp: envelopeTs,
          body: payload.trace
        });

        const generations = payload.generations || (payload.generation ? [payload.generation] : []);
        for (const gen of generations) {
          batch.push({
            id: crypto.randomUUID(),
            type: 'generation-create',
            timestamp: envelopeTs,
            body: { ...gen, traceId: payload.trace.id }
          });
        }

        if (payload.scores && Array.isArray(payload.scores)) {
          for (const score of payload.scores) {
            batch.push({
              id: crypto.randomUUID(),
              type: 'score-create',
              timestamp: envelopeTs,
              body: { ...score, traceId: payload.trace.id }
            });
          }
        }

        if (payload.span) {
          batch.push({
            id: crypto.randomUUID(),
            type: 'span-create',
            timestamp: envelopeTs,
            body: { ...payload.span, traceId: payload.trace.id }
          });
        }
      }

      let accepted = false;
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

          let body: { errors?: Array<{ id?: string; status?: number; message?: string; error?: string }> } | null = null;
          try {
            body = await res.json() as { errors?: Array<{ id?: string; status?: number; message?: string; error?: string }> };
          } catch { /* not JSON */ }

          if (body && Array.isArray(body.errors) && body.errors.length > 0) {
            for (const e of body.errors) {
              console.error(`[ledger] Langfuse per-item error: id=${e.id ?? 'unknown'} status=${e.status ?? 'unknown'} ${e.message ?? e.error ?? ''}`);
            }
          }

          if (res.ok) {
            accepted = true;
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

      const placeholders = rowIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM langfuse_queue WHERE id IN (${placeholders})`).run(...rowIds);
      shipped += rowIds.length;
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
