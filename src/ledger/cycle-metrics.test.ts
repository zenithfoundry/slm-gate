/**
 * Spec tests for the cycle-extension metric and the metrics it sits beside.
 *
 * The headline guard is that "minutes freed" is computed from a real rate
 * (unitsSaved / (windowBudget / windowMinutes)) and NOT from the old
 * `windowMinutes * (tokensSaved / baselineTokens)`, which multiplied a per-event
 * compression ratio by a global window length and produced 178.63 minutes for a single
 * tool call against a 300-minute window.
 */

import { describe, beforeEach, afterEach, it, expect } from '@jest/globals';
import { calculateCostUsd, normalizeModelId } from '../pricing/index.js';
import { __resetProviderRegistry } from '../pricing/providers.js';
import {
  computeCycleRateAvg,
  formatEventForLangfuse,
  LedgerEvent,
  perEventCycleMinutes,
  perEventUnitsSaved,
  routingOutcome,
} from './index.js';

const ev = (o: Partial<LedgerEvent> = {}): LedgerEvent => ({
  ts: '2026-09-13T13:56:35.118Z',
  layer: 'mcp',
  request_id: `r_${Math.random()}`,
  route: 'condition',
  is_local_call: 1,
  slm_model: 'qwen2.5-coder:3b',
  in_tok: 4511,
  out_tok: 1825,
  api_in_tok: 0,
  api_out_tok: 0,
  cost_usd: 0,
  slm_latency_s: 1,
  api_latency_s: 0,
  slm_gate: 'on',
  ...o,
});

const cycleScore = (e: LedgerEvent, provider: string) =>
  formatEventForLangfuse(e).scores?.find(s => s.name === `cycle_extended_per_window_${provider}`);

describe('cycle extension requires a real denominator', () => {
  const clearBudgets = () => {
    delete process.env.CLAUDE_WINDOW_BUDGET;
    delete process.env.CHATGPT_WINDOW_BUDGET;
    delete process.env.GEMINI_WINDOW_BUDGET;
    __resetProviderRegistry();
  };
  beforeEach(clearBudgets);
  afterEach(clearBudgets);

  it('emits NOTHING when the provider window budget is unconfigured', () => {
    // Regression guard for the headline bug. With no budget there is no honest way to turn
    // savings into minutes, so silence is the correct output — not 178.63.
    __resetProviderRegistry();
    const e = ev({ provider: 'claude', agent: 'claude-code', api_model: 'claude-opus-5[1m]' });

    expect(perEventCycleMinutes(e, 'claude')).toBeNull();
    expect(cycleScore(e, 'claude')).toBeUndefined();
  });

  it('never reproduces the old ratio-times-window figure', () => {
    process.env.CLAUDE_WINDOW_BUDGET = '1000000'; // tokens per 5h window
    __resetProviderRegistry();
    const e = ev({ provider: 'claude', in_tok: 4511, out_tok: 1825 });

    // Old formula: 300 * (1 - 1825/4511) = 178.63
    expect(perEventCycleMinutes(e, 'claude')).not.toBeCloseTo(178.63, 1);
  });

  it('claude counts tokens: a distilled tool result extends the window', () => {
    process.env.CLAUDE_WINDOW_BUDGET = '1000000';
    __resetProviderRegistry();
    // 2,686 tokens saved * (300 min / 1,000,000 tokens) = 0.8058 min
    const e = ev({ provider: 'claude', route: 'condition', in_tok: 4511, out_tok: 1825 });
    expect(perEventCycleMinutes(e, 'claude')).toBeCloseTo(0.8058, 4);
    expect(cycleScore(e, 'claude')?.value).toBeCloseTo(0.8058, 4);
  });

  it('message metering: one locally-resolved prompt frees one message of the window', () => {
    process.env.CHATGPT_WINDOW_BUDGET = '90';
    __resetProviderRegistry();
    // 180 minutes / 90 messages = 2 minutes per message avoided.
    expect(perEventCycleMinutes(ev({ provider: 'chatgpt', route: 'defer_local' }), 'chatgpt')).toBeCloseTo(2, 6);
  });

  it('message metering: a distilled-but-forwarded prompt frees nothing — the message was still sent', () => {
    process.env.CHATGPT_WINDOW_BUDGET = '90';
    __resetProviderRegistry();
    expect(perEventCycleMinutes(ev({ provider: 'chatgpt', route: 'condition' }), 'chatgpt')).toBe(0);
    expect(perEventCycleMinutes(ev({ provider: 'chatgpt', route: 'forward_compressed' }), 'chatgpt')).toBe(0);
  });

  it('compute metering: minutes scale with tokens saved against the token budget', () => {
    process.env.GEMINI_WINDOW_BUDGET = '1000000'; // tokens per 5h window
    __resetProviderRegistry();
    // 2,686 tokens saved * (300 min / 1,000,000 tokens) = 0.8058 min
    const e = ev({ provider: 'gemini', route: 'condition', in_tok: 4511, out_tok: 1825 });
    expect(perEventCycleMinutes(e, 'gemini')).toBeCloseTo(0.8058, 4);
  });

  it('clamps to the window length however large the claimed saving', () => {
    process.env.GEMINI_WINDOW_BUDGET = '10';
    __resetProviderRegistry();
    const e = ev({ provider: 'gemini', route: 'defer_local', in_tok: 10_000_000, out_tok: 0 });
    expect(perEventCycleMinutes(e, 'gemini')).toBe(300);
  });

  it('never returns a negative value', () => {
    process.env.GEMINI_WINDOW_BUDGET = '1000';
    __resetProviderRegistry();
    const e = ev({ provider: 'gemini', route: 'forward_compressed', api_in_tok: 5000, api_out_tok: 500, meta: JSON.stringify({ raw_in_tok: 1 }) });
    expect(perEventCycleMinutes(e, 'gemini')).toBeGreaterThanOrEqual(0);
  });

  it('excludes unmeasurable events from the average rather than averaging them as zero', () => {
    __resetProviderRegistry(); // no budgets configured
    expect(computeCycleRateAvg([ev({ provider: 'claude', route: 'defer_local' })], null).claude).toBeNull();
  });
});

describe('units saved reflect how the provider actually meters', () => {
  it('message metering counts requests avoided, not tokens', () => {
    expect(perEventUnitsSaved(ev({ route: 'defer_local' }), 'message')).toBe(1);
    expect(perEventUnitsSaved(ev({ route: 'condition' }), 'message')).toBe(0);
  });

  it('compute metering counts tokens saved', () => {
    expect(perEventUnitsSaved(ev({ route: 'condition', in_tok: 1000, out_tok: 400 }), 'compute')).toBe(600);
  });
});

describe('accuracy is only scored when a verifier actually ran', () => {
  it('emits no accuracy score for an MCP condition event', () => {
    // The MCP path never invokes the verifier, yet every such event used to score 100,
    // making the "SLM Accuracy Rate" widget a tautology.
    const names = (formatEventForLangfuse(ev({ route: 'condition', is_local_call: 1 })).scores ?? []).map(s => s.name);
    expect(names).not.toContain('accuracy_rate_pct');
  });

  it('emits an accuracy score when the llm-gate recorded a local attempt', () => {
    const e = ev({ route: 'defer_local', meta: JSON.stringify({ local_attempted: 1, local_accepted: 1 }) });
    const score = formatEventForLangfuse(e).scores?.find(s => s.name === 'accuracy_rate_pct');
    expect(score?.value).toBe(100);
  });

  it('scores 0 when the verifier flagged a failure', () => {
    const e = ev({ route: 'defer_local', meta: JSON.stringify({ local_attempted: 1 }), verifier_flags: JSON.stringify(['hallucination']) });
    expect(formatEventForLangfuse(e).scores?.find(s => s.name === 'accuracy_rate_pct')?.value).toBe(0);
  });

  it('always honours an explicit quality_score', () => {
    expect(formatEventForLangfuse(ev({ quality_score: 0.8 })).scores?.find(s => s.name === 'accuracy_rate_pct')?.value).toBe(80);
  });
});

describe('routing outcome is three-way and agrees with the trace tags', () => {
  it('classifies a distilled tool result as forwarded, not escalated', () => {
    const e = ev({ route: 'condition' });
    expect(routingOutcome(e)).toBe('distilled_forwarded');
    const payload = formatEventForLangfuse(e);
    expect(payload.scores?.find(s => s.name === 'verified')?.value).toBe('Distilled (Forwarded)');
    // The tag used to say call:local while the score said Escalated (Cloud).
    expect(payload.trace.tags).toContain('outcome:distilled_forwarded');
    expect(payload.trace.tags).not.toContain('call:local');
  });

  it('classifies a locally-resolved prompt as resolved_local', () => {
    expect(routingOutcome(ev({ route: 'defer_local' }))).toBe('resolved_local');
  });

  it('classifies a raw forward as escalated_cloud', () => {
    expect(routingOutcome(ev({ route: 'forward_raw', is_local_call: 0 }))).toBe('escalated_cloud');
  });
});

describe('cost is priced against the event model, not a global reference', () => {
  it('resolves a host-decorated model id to its pricing entry', () => {
    expect(normalizeModelId('claude-opus-5[1m]')).toBe('claude-opus-5');
    expect(normalizeModelId('anthropic/claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('prices Claude traffic at Claude rates, not the Gemini fallback', () => {
    // claude-opus-5 is $5/M input (verified 2026-09-13), vs $0.30/M at the old
    // gemini-2.5-flash fallback the gate used to price all Claude traffic with.
    expect(calculateCostUsd('claude-opus-5[1m]', 1_000_000, 0)).toBeCloseTo(5, 6);
  });

  it('uses the event model for baseline cost on a local event', () => {
    const claude = formatEventForLangfuse(ev({ route: 'defer_local', api_model: 'claude-opus-5[1m]', in_tok: 1_000_000, out_tok: 0 }));
    const gemini = formatEventForLangfuse(ev({ route: 'defer_local', api_model: 'gemini-2.5-flash', in_tok: 1_000_000, out_tok: 0 }));
    expect(Number(claude.trace.metadata?.baseline_cost_usd)).toBeGreaterThan(Number(gemini.trace.metadata?.baseline_cost_usd));
  });
});

describe('feedback events are not conditioning work', () => {
  it('contributes no tokens and no accuracy score', () => {
    const payload = formatEventForLangfuse(ev({ route: 'feedback', is_local_call: 0, in_tok: 0, out_tok: 0 }));
    const names = (payload.scores ?? []).map(s => s.name);
    expect(names).not.toContain('accuracy_rate_pct');
    expect(payload.scores?.find(s => s.name === 'tokens_saved')?.value).toBe(0);
  });
});
