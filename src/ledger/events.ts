/**
 * One event row per request through either gate, and the maths read off those rows: routing outcome,
 * provider attribution (resolveProvider) and the token and window savings that every report and the
 * Langfuse mirror must agree on. writeEvent enriches once and queues the Langfuse copy.
 */
import { CONFIG } from '../config.js';
import {
  getProviderRegistry,
  minutesFreed,
  providerFromAgentName,
  providerFromModelId,
  type MeteringModel,
} from '../pricing/providers.js';
import type { ProviderId } from '../pricing/plans.js';
import { LangfuseSink } from '../langfuse/sink.js';
import { getDb } from './db.js';

export interface LedgerEvent {
  ts: string;
  layer: 'mcp' | 'llm';
  request_id: string;
  session_id?: string;
  skill?: string;
  route: 'defer_local' | 'escalate' | 'forward_compressed' | 'forward_raw' | 'condition' | 'feedback' | 'memory_fold';
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
export function providerFromModel(model?: string): ProviderId | null {
  return providerFromModelId(model) as ProviderId | null;
}

export function providerFromAgent(agent?: string): ProviderId | null {
  return providerFromAgentName(agent) as ProviderId | null;
}

/**
 * Resolves the provider for an event using every available signal, in priority order.
 *
 * @param e The ledger event
 * @param fallbackProvider What an event with no signal of its own is attributed to; CONFIG.PROVIDER by default.
 * @returns Provider id, or null when the event cannot be attributed.
 */
export function resolveProvider(e: LedgerEvent, fallbackProvider: ProviderId | null = CONFIG.PROVIDER ?? null): string | null {
  return e.provider ?? providerFromModelId(e.api_model) ?? providerFromAgentName(e.agent) ?? fallbackProvider;
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

/**
 * Baseline estimate for a forward_compressed row whose meta carries no raw_in_tok: the tokens the cloud model
 * would have read without the gate are taken as this multiple of what it actually read.
 */
export const RAW_TOKEN_RATIO = 1.5;

export function perEventTokensSaved(e: LedgerEvent): number {
  // 'feedback' rows record an elision expansion: the cloud model re-reads text the gate had cut, so the
  // page it received (out_tok) is charged against the savings. Rows written before this had out_tok 0.
  if (e.route === 'feedback') return e.out_tok ? -e.out_tok : 0;
  const parsedMeta = e.meta ? (() => { try { return JSON.parse(e.meta); } catch { return {}; } })() : {};
  if (e.route === 'defer_local') {
    return (e.in_tok || 0) + (e.out_tok || 0);
  } else if (e.route === 'forward_compressed') {
    const rawInTok = typeof parsedMeta.raw_in_tok === 'number' ? parsedMeta.raw_in_tok : (e.api_in_tok > 0 ? Math.round(e.api_in_tok * RAW_TOKEN_RATIO) : e.in_tok);
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
    const rawInTok = typeof parsedMeta.raw_in_tok === 'number' ? parsedMeta.raw_in_tok : (e.api_in_tok > 0 ? Math.round(e.api_in_tok * RAW_TOKEN_RATIO) : e.in_tok);
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
  fallbackProvider: ProviderId | null = CONFIG.PROVIDER ?? null
) {
  const stats = {
    claude: { tokensSaved: 0, baselineTokens: 0 },
    chatgpt: { tokensSaved: 0, baselineTokens: 0 },
    gemini: { tokensSaved: 0, baselineTokens: 0 },
  };
  for (const r of rows) {
    const p = resolveProvider(r, fallbackProvider);
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
  fallbackProvider: ProviderId | null = CONFIG.PROVIDER ?? null
): Record<ProviderId, number> {
  // Aggregate minutes freed across all of a provider's traffic. Uses the same rate-based
  // definition as the per-event score, so the two can never disagree.
  const out: any = { claude: 0, chatgpt: 0, gemini: 0 };
  for (const r of rows) {
    const p = resolveProvider(r, fallbackProvider);
    if (p && p in out) {
      out[p] += perEventCycleMinutes(r, p) ?? 0;
    }
  }
  for (const p of Object.keys(out)) out[p] = Number(out[p].toFixed(2));
  return out;
}

export function computeCycleRateAvg(
  rows: LedgerEvent[],
  fallbackProvider: ProviderId | null = CONFIG.PROVIDER ?? null
): Record<ProviderId, number | null> {
  const counts: Record<ProviderId, number> = { claude: 0, chatgpt: 0, gemini: 0 };
  const sums: Record<ProviderId, number> = { claude: 0, chatgpt: 0, gemini: 0 };

  for (const r of rows) {
    const p = resolveProvider(r, fallbackProvider) as ProviderId | null;
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
    provider: resolveProvider(e),
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
