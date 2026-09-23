/**
 * Regression guards for the telemetry transport layer.
 *
 * Each test here corresponds to a defect that made the Langfuse dashboard unreadable:
 * collapsed timestamps, benchmark data mixed into real traffic, and provider attribution
 * that differed between SQLite and Langfuse.
 */

import { formatEventForLangfuse, LedgerEvent, SLM_GATE_SOURCE_TAG } from './index.js';
import { __resetProviderRegistry } from '../pricing/providers.js';

const ev = (o: Partial<LedgerEvent> = {}): LedgerEvent => ({
  ts: '2026-09-11T22:05:11.775Z',
  layer: 'mcp',
  request_id: 'req_fixture',
  route: 'condition',
  is_local_call: 1,
  slm_model: 'qwen2.5-coder:3b',
  in_tok: 4511,
  out_tok: 1825,
  api_in_tok: 0,
  api_out_tok: 0,
  cost_usd: 0,
  slm_latency_s: 1.2,
  api_latency_s: 0,
  slm_gate: 'on',
  ...o,
});

describe('event time is preserved end-to-end', () => {
  it('carries the event timestamp on the payload so the flush can stamp the envelope', () => {
    // Langfuse stamps the ingestion ENVELOPE, not the body, and ScoreBody has no timestamp
    // field at all. Before this, every score landed at flush time and the entire history
    // collapsed onto a few instants — which is what broke the date range filters.
    const payload = formatEventForLangfuse(ev({ ts: '2026-09-11T22:05:11.775Z' }));
    expect(payload.eventTs).toBe('2026-09-11T22:05:11.775Z');
  });

  it('stamps the trace body with the event time, not the current time', () => {
    const payload = formatEventForLangfuse(ev({ ts: '2026-09-11T22:05:11.775Z' }));
    expect(payload.trace.timestamp).toBe('2026-09-11T22:05:11.775Z');
  });

  it('normalises a non-ISO ts rather than emitting it raw', () => {
    const payload = formatEventForLangfuse(ev({ ts: '2026-09-11 22:05:11Z' }));
    expect(payload.eventTs).toBe(new Date('2026-09-11 22:05:11Z').toISOString());
  });
});

describe('environment separates benchmark traffic from real traffic', () => {
  it('propagates an explicit environment to trace, generations and scores', () => {
    // The harness tags its events 'bench'. If this regresses, benchmark runs silently
    // skew every dashboard widget, because Langfuse's Env selector filters on this field.
    const payload = formatEventForLangfuse(ev({ environment: 'bench' }));

    expect(payload.environment).toBe('bench');
    expect(payload.trace.environment).toBe('bench');
    expect(payload.generations?.length).toBeGreaterThan(0);
    for (const g of payload.generations ?? []) expect(g.environment).toBe('bench');
    expect(payload.scores?.length).toBeGreaterThan(0);
    for (const s of payload.scores ?? []) expect(s.environment).toBe('bench');
  });

  it('defaults to the configured environment when the event does not set one', () => {
    const payload = formatEventForLangfuse(ev());
    expect(payload.trace.environment).toBeTruthy();
    expect(payload.trace.environment).not.toBe('bench');
  });
});

describe('the gate\'s traces are told apart from other writers to the same project', () => {
  it('tags every trace with the source tag ledger:verify and langfuse:wipe select on', () => {
    // Another program writes to the same Langfuse project; without a tag only the gate
    // writes, its traces could not be counted or deleted apart from the gate's.
    for (const route of ['condition', 'feedback', 'defer_local', 'forward_raw'] as const) {
      expect(formatEventForLangfuse(ev({ route })).trace.tags).toContain(SLM_GATE_SOURCE_TAG);
    }
  });
});

describe('provider attribution is carried, not re-derived', () => {
  afterEach(() => {
    delete process.env.CLAUDE_WINDOW_BUDGET;
    __resetProviderRegistry();
  });

  it('uses the provider already resolved onto the event', () => {
    // writeEvent now enriches a single event object and mirrors THAT, so SQLite and
    // Langfuse cannot disagree. Previously the un-enriched event was mirrored and
    // Langfuse re-derived provider through a chain ending in CONFIG.PROVIDER.
    process.env.CLAUDE_WINDOW_BUDGET = '250';
    __resetProviderRegistry();
    const payload = formatEventForLangfuse(ev({ provider: 'claude', route: 'defer_local', api_model: undefined, agent: undefined }));
    const cycle = payload.scores?.find(s => s.name.startsWith('cycle_extended_'));
    expect(cycle?.name).toBe('cycle_extended_minutes_claude');
  });

  it('prefers an explicit provider over what the model string would imply', () => {
    process.env.CLAUDE_WINDOW_BUDGET = '250';
    __resetProviderRegistry();
    const payload = formatEventForLangfuse(ev({ provider: 'claude', route: 'defer_local', api_model: 'gemini-2.5-flash' }));
    const cycle = payload.scores?.find(s => s.name.startsWith('cycle_extended_'));
    expect(cycle?.name).toBe('cycle_extended_minutes_claude');
  });
});
