import { jest } from '@jest/globals';

const mockRun = jest.fn();
const mockGet = jest.fn();
const mockAll = jest.fn();
const mockPrepare = jest.fn(() => ({
  run: mockRun,
  get: mockGet,
  all: mockAll,
}));
const mockExec = jest.fn();
const mockPragma = jest.fn();
const mockClose = jest.fn();

const MockDatabase = jest.fn(() => ({
  prepare: mockPrepare,
  exec: mockExec,
  pragma: mockPragma,
  close: mockClose,
}));

jest.unstable_mockModule('better-sqlite3', () => ({
  default: MockDatabase,
}));

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    LANGFUSE_PUBLIC_KEY: '',
    LANGFUSE_SECRET_KEY: '',
    LANGFUSE_HOST: '',
    LANGFUSE_ENVIRONMENT: 'default',
    PROVIDER: undefined,
    RESOLVED_PLAN_CLAUDE: { windowMinutes: 300, plan: 'claude-pro' },
    RESOLVED_PLAN_CHATGPT: { windowMinutes: 180, plan: 'chatgpt-plus' },
    RESOLVED_PLAN_GEMINI: { windowMinutes: 300, plan: 'gemini-ultra' }
  }
}));

const { getDb, writeEvent, cacheGet, cacheSet, LangfuseSink, formatEventForLangfuse, computeCycleRateAvg } = await import('../../src/ledger/index.js');
const { __resetProviderRegistry } = await import('../../src/pricing/providers.js');

describe('Ledger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDb(); // Initialize DB once per test to consume the policy table init query
    LangfuseSink.__resetForTests();
  });

  afterAll(() => {
    // Ensure DB is closed if needed, but in memory should be fine.
    const db = getDb();
    db.close();
  });

  test('writes event successfully', () => {
    const event = {
      ts: new Date().toISOString(),
      layer: 'llm' as const,
      request_id: 'req_123',
      route: 'defer_local' as const,
      is_local_call: 1,
      in_tok: 10,
      out_tok: 20,
      api_in_tok: 0,
      api_out_tok: 0,
      cost_usd: 0.001,
      slm_latency_s: 0.5,
      api_latency_s: 0,
      slm_gate: 'on' as const,
    };

    writeEvent(event);

    expect(mockPrepare).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ request_id: 'req_123' }));
  });

  test('cache set and get', () => {
    mockGet.mockReturnValue({ value: 'my_value' });
    cacheSet('my_key', 'my_value');
    expect(mockPrepare).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith('my_key', 'my_value', expect.any(String));

    const val = cacheGet('my_key');
    expect(val).toBe('my_value');

    mockGet.mockReturnValue(undefined);
    const missing = cacheGet('not_exist');
    expect(missing).toBeNull();
  });

  test('langfuse disabled no-op path', () => {
    // Langfuse properties are empty in the mock, so hasValidConfig() should return false
    const valid = LangfuseSink.hasValidConfig();
    expect(valid).toBe(false);

    // Invoking writeEvent shouldn't crash
    const event = {
      ts: new Date().toISOString(),
      layer: 'llm' as const,
      request_id: 'req_langfuse_test',
      route: 'defer_local' as const,
      is_local_call: 0,
      in_tok: 0,
      out_tok: 0,
      api_in_tok: 0,
      api_out_tok: 0,
      cost_usd: 0,
      slm_latency_s: 0,
      api_latency_s: 0,
      slm_gate: 'off' as const,
    };

    expect(() => writeEvent(event)).not.toThrow();
  });

  const withGeminiBudget = (fn: () => void) => {
    process.env.GEMINI_WINDOW_BUDGET = '1000000';
    __resetProviderRegistry();
    try { fn(); } finally {
      delete process.env.GEMINI_WINDOW_BUDGET;
      __resetProviderRegistry();
    }
  };

  test('emits NO cycle score when the provider has no configured window budget', () => {
    __resetProviderRegistry();
    const event = {
      ts: new Date().toISOString(), layer: 'mcp' as const, request_id: 'req_no_budget',
      route: 'condition' as const, is_local_call: 1, in_tok: 100, out_tok: 50,
      api_in_tok: 0, api_out_tok: 0, cost_usd: 0, slm_latency_s: 0.1, api_latency_s: 0,
      slm_gate: 'on' as const, api_model: 'gemini-2.5-flash',
    };
    const scores = (formatEventForLangfuse(event).scores || []).filter(sc => sc.name.startsWith('cycle_extended_'));
    expect(scores).toHaveLength(0);
  });

  test('emits per-event cycle score for gemini event and avoids other providers', () => {
    const event = {
      ts: new Date().toISOString(),
      layer: 'mcp' as const,
      request_id: 'req_gemini_1',
      route: 'condition' as const,
      is_local_call: 1,
      in_tok: 100,
      out_tok: 50,
      api_in_tok: 0,
      api_out_tok: 0,
      cost_usd: 0,
      slm_latency_s: 0.1,
      api_latency_s: 0,
      slm_gate: 'on' as const,
      api_model: 'gemini-2.5-flash',
    };

    withGeminiBudget(() => {
      const payload = formatEventForLangfuse(event);
      const cycleScores = (payload.scores || []).filter(s => s.name.startsWith('cycle_extended_'));

      // Two scores: the same saving in minutes and in seconds, for the resolved provider
      // only. Langfuse cards cannot convert units, so each unit needs its own score.
      expect(cycleScores.map(s => s.name).sort()).toEqual([
        'cycle_extended_minutes_gemini',
        'cycle_extended_seconds_gemini',
      ]);
      // 50 tokens saved * (300 min / 1,000,000 tokens) = 0.015 min.
      // The old assertion was 150 — half a 5-hour window from one 100-token call.
      expect(cycleScores.find(s => s.name === 'cycle_extended_minutes_gemini')?.value).toBeCloseTo(0.015, 6);
      expect(cycleScores.find(s => s.name === 'cycle_extended_seconds_gemini')?.value).toBe(0.9);
    });
  });

  test('event with no resolvable provider emits no cycle score', () => {
    const event = {
      ts: new Date().toISOString(),
      layer: 'llm' as const,
      request_id: 'req_unknown_1',
      route: 'condition' as const,
      is_local_call: 1,
      in_tok: 100,
      out_tok: 50,
      api_in_tok: 0,
      api_out_tok: 0,
      cost_usd: 0,
      slm_latency_s: 0.1,
      api_latency_s: 0,
      slm_gate: 'on' as const,
      api_model: 'custom-model-without-provider',
    };

    const payload = formatEventForLangfuse(event);
    const cycleScores = (payload.scores || []).filter(s => s.name.startsWith('cycle_extended_'));
    expect(cycleScores).toHaveLength(0);
  });

  test('escalated gemini event emits value 0 for cycle score', () => {
    const event = {
      ts: new Date().toISOString(),
      layer: 'llm' as const,
      request_id: 'req_gemini_esc',
      route: 'escalate' as const,
      is_local_call: 0,
      in_tok: 0,
      out_tok: 0,
      api_in_tok: 100,
      api_out_tok: 50,
      cost_usd: 0.005,
      slm_latency_s: 0.1,
      api_latency_s: 0.5,
      slm_gate: 'on' as const,
      api_model: 'gemini-2.5-flash',
    };

    withGeminiBudget(() => {
      const payload = formatEventForLangfuse(event);
      const cycleScores = (payload.scores || []).filter(s => s.name.startsWith('cycle_extended_'));

      expect(cycleScores.map(s => s.name).sort()).toEqual([
        'cycle_extended_minutes_gemini',
        'cycle_extended_seconds_gemini',
      ]);
      expect(cycleScores.every(s => s.value === 0)).toBe(true);
    });
  });

  test('computeCycleRateAvg equals mean of emitted per-event values for provider', () => {
    const rows = [
      {
        ts: new Date().toISOString(),
        layer: 'mcp' as const,
        request_id: 'r1',
        route: 'condition' as const,
        is_local_call: 1,
        in_tok: 100,
        out_tok: 50,
        api_in_tok: 0,
        api_out_tok: 0,
        cost_usd: 0,
        slm_latency_s: 0,
        api_latency_s: 0,
        slm_gate: 'on' as const,
        api_model: 'gemini-2.5-flash',
      },
      {
        ts: new Date().toISOString(),
        layer: 'llm' as const,
        request_id: 'r2',
        route: 'escalate' as const,
        is_local_call: 0,
        in_tok: 0,
        out_tok: 0,
        api_in_tok: 200,
        api_out_tok: 0,
        cost_usd: 0,
        slm_latency_s: 0,
        api_latency_s: 0,
        slm_gate: 'on' as const,
        api_model: 'gemini-2.5-flash',
      },
      {
        ts: new Date().toISOString(),
        layer: 'mcp' as const,
        request_id: 'r3',
        route: 'condition' as const,
        is_local_call: 1,
        in_tok: 300,
        out_tok: 0,
        api_in_tok: 0,
        api_out_tok: 0,
        cost_usd: 0,
        slm_latency_s: 0,
        api_latency_s: 0,
        slm_gate: 'on' as const,
        api_model: 'claude-3-5-sonnet',
      }
    ];

    process.env.GEMINI_WINDOW_BUDGET = '1000000';
    process.env.CLAUDE_WINDOW_BUDGET = '250';
    __resetProviderRegistry();
    try {
      const v1 = formatEventForLangfuse(rows[0]).scores?.find(s => s.name === 'cycle_extended_minutes_gemini')?.value as number;
      const v2 = formatEventForLangfuse(rows[1]).scores?.find(s => s.name === 'cycle_extended_minutes_gemini')?.value as number;
      const v3 = formatEventForLangfuse(rows[2]).scores?.find(s => s.name === 'cycle_extended_minutes_claude')?.value as number;

      // The invariant that matters: the aggregate is exactly the mean of what was emitted
      // per event, so the dashboard average can never drift from the underlying scores.
      const avg = computeCycleRateAvg(rows);
      expect(avg.gemini).toBeCloseTo((v1 + v2) / 2, 9);
      expect(avg.claude).toBeCloseTo(v3, 9);
      expect(avg.chatgpt).toBeNull();
    } finally {
      delete process.env.GEMINI_WINDOW_BUDGET;
      delete process.env.CLAUDE_WINDOW_BUDGET;
      __resetProviderRegistry();
    }
  });

  test('flushQueue parses and logs 207 per-item errors to stderr', async () => {
    mockAll.mockReturnValue([
      { id: 1, payload: JSON.stringify({ trace: { id: 't1' }, scores: [] }) }
    ]);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 207,
      json: () => Promise.resolve({
        errors: [{ id: 'err_score_1', status: 400, message: 'Invalid score' }]
      })
    } as any));

    const { CONFIG } = await import('../../src/config.js');
    const origKey = CONFIG.LANGFUSE_PUBLIC_KEY;
    Object.assign(CONFIG, {
      LANGFUSE_PUBLIC_KEY: 'test',
      LANGFUSE_SECRET_KEY: 'test',
      LANGFUSE_HOST: 'http://test'
    });

    await LangfuseSink.flushQueue();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('err_score_1')
    );

    Object.assign(CONFIG, {
      LANGFUSE_PUBLIC_KEY: origKey,
      LANGFUSE_SECRET_KEY: '',
      LANGFUSE_HOST: ''
    });
    errorSpy.mockRestore();
    delete (global as any).fetch;
  });
});
