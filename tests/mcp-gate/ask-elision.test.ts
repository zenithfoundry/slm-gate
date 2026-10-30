/**
 * @fileoverview `ask_elision`: the MCP gate answers a question about elided text from the stored
 * original with the brain model, caches the answer, and records what the cloud model would have read instead.
 * The brain is faked; no Ollama. The marker-wording test pairs `formatElisionMarker` with `rewriteElisionHint`.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    DOWNSTREAM_MCP: { command: 'echo' },
    MCP_GATE_TRANSPORT: 'stdio',
    DISTILL_MAX_TOKENS: 2000,
    PROMPT_VERSION: 'ask-test',
    SLM_BRAIN_MODEL: 'brain-under-test',
    CONVERSATION_MEMORY: true,
    MEMORY_MATCH_WINDOW_MS: 600000,
    ELISION_RETENTION_DAYS: 180,
    ELISION_MAX_MB: 10,
    ELISION_MAX_ENTRIES: 5000,
  }
}));

jest.unstable_mockModule('../../src/mcp-gate/pipeline.js', () => ({
  conditionPrompt: jest.fn(async ({ text }: { text: string }) => text),
}));

// No Ollama in tests: the brain finds the answer only in the part that holds the marker word.
const answerFromText = jest.fn(async ({ text }: { text: string }) =>
  text.includes('ANSWER-HERE')
    ? { found: true, answer: 'Reviews must be answered within 30 min.', lines: [2, 2] as [number, number] }
    : { found: false, answer: '', lines: null });
jest.unstable_mockModule('../../src/models/reasoning.js', () => ({
  answerFromText,
  // Conversation memory's fold is never reached here; the names must still exist for the module graph.
  MEMORY_SCHEMA: { parse: (v: unknown) => v },
  foldSummary: jest.fn(async () => ({ goal: '', decided: [], inPlay: [] })),
}));
jest.unstable_mockModule('../../src/models/slm.js', () => ({ SLM: class {} }));

jest.unstable_mockModule('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(),
    request: jest.fn(async () => ({ tools: [] })),
    getInstructions: () => undefined,
  }))
}));

const { CONFIG } = await import('../../src/config.js');
const { writeElision, getDb, writeMemoryRow } = await import('../../src/ledger/index.js');
const { formatElisionMarker, rewriteElisionHint } = await import('../../src/utils/elision.js');
const { createServer } = await import('../../src/mcp-gate/server.js');

// ≈6,000 tokens over 400 lines with headings, so the original splits into more than one part; the answer sits
// in the second part.
const lines = Array.from({ length: 400 }, (_, i) =>
  i % 50 === 0 ? `## Part ${i / 50}` : i === 330 ? 'ANSWER-HERE: reviews are answered within 30 min during working hours.' : `line ${i}: ${'prose about the workflow '.repeat(3)}`);
const ID = 'ask-under-test';
writeElision({ id: ID, tool_name: 'get_skill', args: '{}', original_text: lines.join('\n'), ranges: JSON.stringify({ startLine: 0, endLine: 399 }), content_hash: 'h', size_bytes: lines.join('\n').length });

/** Calls one gate tool through the real MCP request handler and returns its first text block. */
const call = async (name: string, args: Record<string, unknown>, rootUri?: string) => {
  const { server } = await createServer({ rootUri });
  const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
  const result = await handler({ method: 'tools/call', params: { name, arguments: args } }, {});
  return result.content[0].text as string;
};

beforeEach(() => {
  answerFromText.mockClear();
});

describe('ask_elision', () => {
  it('is advertised next to expand_elision; find_existing only with REPO_INDEX on', async () => {
    const { server } = await createServer();
    const list = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const names = async () => ((await list({ method: 'tools/list' }, {})).tools as { name: string }[]).map(t => t.name);
    expect(await names()).toEqual(expect.arrayContaining(['expand_elision', 'ask_elision']));
    expect(await names()).not.toContain('find_existing');
    (CONFIG as any).REPO_INDEX = true;
    try {
      expect(await names()).toContain('find_existing');
    } finally {
      (CONFIG as any).REPO_INDEX = false;
    }
  });

  it('answers from the part of the original that holds the answer and cites its lines', async () => {
    const text = await call('ask_elision', { elisionId: ID, question: 'How fast must a review be answered?' });
    expect(text).toContain('Reviews must be answered within 30 min.');
    expect(text).toMatch(/\(original lines \d+-\d+\)/);
    // Parts before the one holding the answer are checked first; the search stops at the hit.
    const parts = answerFromText.mock.calls.map(c => (c[0] as { text: string }).text);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.slice(0, -1).some(p => p.includes('ANSWER-HERE'))).toBe(false);
    expect(parts[parts.length - 1]).toContain('ANSWER-HERE');
  });

  it('serves the same question again from the cache without a model call', async () => {
    const text = await call('ask_elision', { elisionId: ID, question: 'How fast must a review be answered?' });
    expect(text).toContain('Reviews must be answered within 30 min.');
    expect(answerFromText).not.toHaveBeenCalled();
  });

  it('records a conditioning row charged against the page the cloud model would have read', async () => {
    const row = getDb().prepare("SELECT route, in_tok, out_tok, slm_model, meta FROM events WHERE request_id LIKE 'ask_%' ORDER BY rowid ASC LIMIT 1").get() as { route: string; in_tok: number; out_tok: number; slm_model: string; meta: string };
    expect(row.route).toBe('condition');
    expect(row.in_tok).toBe(2000);
    expect(row.out_tok).toBeGreaterThan(0);
    expect(row.out_tok).toBeLessThan(row.in_tok);
    const meta = JSON.parse(row.meta);
    expect(meta).toMatchObject({ type: 'ask_elision', found: 1 });
    expect(meta.chunks_checked).toBeGreaterThanOrEqual(2);
    expect(meta.chunks_checked).toBeLessThanOrEqual(meta.chunks);
  });

  it('says where to look when nothing in the original answers the question', async () => {
    answerFromText.mockImplementation(async () => ({ found: false, answer: '', lines: null }));
    const text = await call('ask_elision', { elisionId: ID, question: 'What colour is the logo?' });
    expect(text).toMatch(/^Not found in the elided text/);
    expect(text).toContain('range {"startLine": 0, "endLine": 399}');
  });

  it('rejects an unknown id, and answers a missing question with an MCP error result naming the argument', async () => {
    await expect(call('ask_elision', { elisionId: 'nope', question: 'x?' })).rejects.toThrow(/not found/);
    const { server } = await createServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const result = await handler({ method: 'tools/call', params: { name: 'ask_elision', arguments: { elisionId: ID } } }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ask_elision: invalid arguments \(question: Required\)/);
    expect(answerFromText).not.toHaveBeenCalled();
  });

  it('advertises each gate tool with the schema it parses arguments against', async () => {
    const { server } = await createServer();
    const list = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const tools = (await list({ method: 'tools/list' }, {})).tools as { name: string; inputSchema: { type: string; required?: string[]; properties: Record<string, unknown> } }[];
    const ask = tools.find(t => t.name === 'ask_elision')!;
    expect(ask.inputSchema.type).toBe('object');
    expect(ask.inputSchema.required).toEqual(['elisionId', 'question']);
    expect(Object.keys(ask.inputSchema.properties)).toEqual(['elisionId', 'question']);
    const expand = tools.find(t => t.name === 'expand_elision')!;
    expect(expand.inputSchema.required).toEqual(['elisionId']);
    expect(expand.inputSchema.properties.range).toMatchObject({ type: 'object', required: ['startLine', 'endLine'] });
  });
});

describe('the elision marker names both ways back to the original', () => {
  it('mentions ask_elision next to expand_elision, and the no-MCP rewrite removes the whole clause', () => {
    const marker = formatElisionMarker({ elisionId: 'id1', elidedLinesCount: 12, startLine: 3, endLine: 14 });
    expect(marker).toContain('call expand_elision with this id and range {"startLine": 3, "endLine": 14} to retrieve, or ask_elision with this id and a question');
    const rewritten = rewriteElisionHint(marker);
    expect(rewritten).not.toContain('expand_elision');
    expect(rewritten).not.toContain('ask_elision');
  });
});

describe('ask_elision with conversation memory (slice 3)', () => {
  const ROOT = '/repo/with-memory';
  const future = new Date(Date.now() + 60_000).toISOString();
  const summary = JSON.stringify({ goal: 'Finish the review step', decided: ['Reviews are answered within 30 min'], inPlay: ['review-workflow.md'] });
  const row = (over: Partial<Parameters<typeof writeMemoryRow>[0]> = {}) => writeMemoryRow({
    key: 'k1', root: ROOT, summary, turns: 4, discriminator: null, started_at: future, folded_at: future, fold_count: 1, fold_ms: 10, prompt_version: 'ask-test', ...over,
  });
  const lastPrompt = () => (answerFromText.mock.calls.at(-1)?.[0] as { context?: string | null }).context ?? null;
  const lastMeta = () => JSON.parse((getDb().prepare("SELECT meta FROM events WHERE request_id LIKE 'ask_%' ORDER BY rowid DESC LIMIT 1").get() as { meta: string }).meta);

  beforeEach(() => {
    getDb().prepare('DELETE FROM conversation_memory').run();
    getDb().prepare("DELETE FROM cache WHERE key LIKE 'ask_%'").run();
    answerFromText.mockImplementation(async ({ text }: { text: string }) =>
      text.includes('ANSWER-HERE') ? { found: true, answer: 'Reviews must be answered within 30 min.', lines: [2, 2] as [number, number] } : { found: false, answer: '', lines: null });
  });

  it('hands the brain the conversation summary when a usable memory exists for the workspace, and says so on the row', async () => {
    row();
    await call('ask_elision', { elisionId: ID, question: 'Which step are we on?' }, `file://${ROOT}`);
    expect(lastPrompt()).toContain('Goal: Finish the review step');
    expect(lastMeta().memory).toEqual({ match: 'root-recent' });
  });

  it('ignores a memory older than the window, from another workspace, or from a conversation that began before this session', async () => {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    row({ folded_at: old });
    await call('ask_elision', { elisionId: ID, question: 'Which step are we on? (stale)' }, `file://${ROOT}`);
    expect(lastPrompt()).toBeNull();
    expect(lastMeta().memory).toEqual({ match: 'none' });

    row({ root: '/elsewhere' });
    await call('ask_elision', { elisionId: ID, question: 'Which step are we on? (other root)' }, `file://${ROOT}`);
    expect(lastPrompt()).toBeNull();

    row({ started_at: new Date(Date.now() - 3_600_000).toISOString() });
    await call('ask_elision', { elisionId: ID, question: 'Which step are we on? (older conversation)' }, `file://${ROOT}`);
    expect(lastPrompt()).toBeNull();
  });

  it('caches with a memory part, so the same question answered without memory is not served from the memory answer', async () => {
    row();
    await call('ask_elision', { elisionId: ID, question: 'Cache key question?' }, `file://${ROOT}`);
    const keys = () => (getDb().prepare("SELECT key FROM cache WHERE key LIKE 'ask_%'").all() as { key: string }[]).map(r => r.key);
    expect(keys().some(k => k.includes('_m'))).toBe(true);
    getDb().prepare('DELETE FROM conversation_memory').run();
    answerFromText.mockClear();
    await call('ask_elision', { elisionId: ID, question: 'Cache key question?' }, `file://${ROOT}`);
    expect(answerFromText).toHaveBeenCalled();
    expect(keys().some(k => k.endsWith('_nomem'))).toBe(true);
  });
});
