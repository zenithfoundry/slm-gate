/**
 * Turns one ledger event into the Langfuse trace, generations and scores the dashboard cards read. Pure:
 * queueing and shipping are in sink.ts, so a formatting change never touches the transport.
 */
import { CONFIG } from '../config.js';
import { FALLBACK_CLOUD_MODEL, safeCalculateCostUsd } from '../pricing/index.js';
import {
  perEventBaselineTokens,
  perEventCycleMinutes,
  perEventTokensSaved,
  RAW_TOKEN_RATIO,
  resolveProvider,
  routingOutcome,
  type LedgerEvent,
  type RoutingOutcome,
} from '../ledger/events.js';

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
  const referenceCloudModel = e.api_model || CONFIG.CLOUD_MODEL || FALLBACK_CLOUD_MODEL;
  
  const baselineTokens = perEventBaselineTokens(e);
  const tokensSaved = perEventTokensSaved(e);
  let baselineCostUsd = 0;
  let costSavedUsd = 0;
  
  const parsedMeta = e.meta ? (() => { try { return JSON.parse(e.meta); } catch { return {}; } })() : {};
  
  if (e.route === 'defer_local') {
    baselineCostUsd = safeCalculateCostUsd({ model: referenceCloudModel, inTok: e.in_tok, outTok: e.out_tok });
    costSavedUsd = baselineCostUsd;
  } else if (e.route === 'forward_compressed') {
    const rawInTok = typeof parsedMeta.raw_in_tok === 'number' ? parsedMeta.raw_in_tok : (e.api_in_tok > 0 ? Math.round(e.api_in_tok * RAW_TOKEN_RATIO) : e.in_tok);
    baselineCostUsd = safeCalculateCostUsd({ model: referenceCloudModel, inTok: rawInTok, outTok: e.api_out_tok || e.out_tok || 0 });
    costSavedUsd = Math.max(0, baselineCostUsd - (e.cost_usd || 0));
  } else if (e.route === 'condition') {
    baselineCostUsd = safeCalculateCostUsd({ model: referenceCloudModel, inTok: baselineTokens, outTok: 0 });
    const conditionedCostUsd = safeCalculateCostUsd({ model: referenceCloudModel, inTok: e.out_tok || 0, outTok: 0 });
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
