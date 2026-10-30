/**
 * @fileoverview The resolver's cloud tier: the request takes the shape of the configured API style, a cost
 * row is written only for a reply that was paid for, and a failed call leaves the ledger untouched.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '', LANGFUSE_HOST: '', LANGFUSE_ENVIRONMENT: 'test',
    PROVIDER: undefined,
    RESOLVED_PLAN_CLAUDE: { windowMinutes: 300, plan: 'claude-pro', windowBudget: null },
    RESOLVED_PLAN_CHATGPT: { windowMinutes: 180, plan: 'chatgpt-plus', windowBudget: null },
    RESOLVED_PLAN_GEMINI: { windowMinutes: 300, plan: 'gemini-ultra', windowBudget: null },
    ELISION_RETENTION_DAYS: 180,
    SLM_BRAIN_MODEL: 'brain', SLM_GATE_MODEL: 'gate', SLM_TIMEOUT_MS: 5000,
    SELF_CONSISTENCY_K: 1, SELF_CONSISTENCY_TEMP: 0.7,
    REPO_INDEX: false,
    RESOLVER_CLOUD_TIER: true, RESOLVER_CLOUD_BUDGET_USD: 5,
    CLOUD_API_STYLE: 'anthropic', CLOUD_API_KEY: 'sk-ant-test', CLOUD_MODEL: 'claude-sonnet-5', CLOUD_BASE_URL: undefined,
  },
}));

const { resolveAmbiguities } = await import('../../src/resolver/index.js');
const { getDb } = await import('../../src/ledger/index.js');

/** The brain's answers, in the order the resolver asks: the open decisions, the convention guess, the risk. */
const brain = () => ({
  generateJSON: jest.fn<() => Promise<unknown>>()
    .mockResolvedValueOnce({ decisions: [{ id: 'd1', question: 'Which test runner?', kind: 'tool' }] })
    .mockResolvedValueOnce({ answer: 'mocha', options: ['jest'] })
    .mockResolvedValueOnce({ risk: 'low' }),
}) as any;

const escalateRows = () => getDb().prepare("SELECT request_id, cost_usd FROM events WHERE route = 'escalate'").all() as { request_id: string; cost_usd: number }[];

describe('resolver cloud tier', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM events').run();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends an Anthropic Messages request when CLOUD_API_STYLE is anthropic and records one cost row', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: '```json\n{"answers":[{"id":"d1","answer":"jest","confidence":0.9}]}\n```' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const out = await resolveAmbiguities({ slm: brain(), fsRead: async () => [], skillText: '# Skill', task: 'add tests' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' });
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'claude-sonnet-5', max_tokens: expect.any(Number), messages: [{ role: 'user', content: expect.stringContaining('Which test runner?') }] });
    expect(body).not.toHaveProperty('response_format');

    expect(out.autoApplied).toEqual([expect.objectContaining({ id: 'd1', answer: 'jest' })]);
    const rows = escalateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBeGreaterThan(0);
    expect(rows[0].request_id).toMatch(/^resolver_cloud_[0-9a-f-]{36}$/);
  });

  it('writes no cost row when the cloud call fails', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const out = await resolveAmbiguities({ slm: brain(), fsRead: async () => [], skillText: '# Skill', task: 'add tests' });

    expect(out.askUser).toEqual([expect.objectContaining({ id: 'd1', recommendedAnswer: 'mocha' })]);
    expect(escalateRows()).toEqual([]);
  });
});
