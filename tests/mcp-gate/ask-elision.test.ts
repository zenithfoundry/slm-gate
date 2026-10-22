/**
 * @fileoverview `ask_elision` (slice 6): the MCP gate answers a question about elided text from the stored
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
    ELISION_RETENTION_DAYS: 180,
    ELISION_MAX_MB: 10,
    ELISION_MAX_ENTRIES: 5000,
  }
}));

jest.unstable_mockModule('../../src/mcp-gate/pipeline.js', () => ({
  conditionPrompt: jest.fn(async (text: string) => text),
}));

// No Ollama in tests: the brain finds the answer only in the part that holds the marker word.
const answerFromText = jest.fn(async ({ text }: { text: string }) =>
  text.includes('ANSWER-HERE')
    ? { found: true, answer: 'Reviews must be answered within 30 min.', lines: [2, 2] as [number, number] }
    : { found: false, answer: '', lines: null });
jest.unstable_mockModule('../../src/models/reasoning.js', () => ({ answerFromText }));
jest.unstable_mockModule('../../src/models/slm.js', () => ({ SLM: class {} }));

jest.unstable_mockModule('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(),
    request: jest.fn(async () => ({ tools: [] })),
    getInstructions: () => undefined,
  }))
}));

const { CONFIG } = await import('../../src/config.js');
const { writeElision, getDb } = await import('../../src/ledger/index.js');
const { formatElisionMarker, rewriteElisionHint } = await import('../../src/utils/elision.js');
const { createServer } = await import('../../src/mcp-gate/server.js');

// ≈6,000 tokens over 400 lines with headings, so the original splits into more than one part; the answer sits
// in the second part.
const lines = Array.from({ length: 400 }, (_, i) =>
  i % 50 === 0 ? `## Part ${i / 50}` : i === 330 ? 'ANSWER-HERE: reviews are answered within 30 min during working hours.' : `line ${i}: ${'prose about the workflow '.repeat(3)}`);
const ID = 'ask-under-test';
writeElision({ id: ID, tool_name: 'get_skill', args: '{}', original_text: lines.join('\n'), ranges: JSON.stringify({ startLine: 0, endLine: 399 }), content_hash: 'h', size_bytes: lines.join('\n').length });

/** Calls one gate tool through the real MCP request handler and returns its first text block. */
const call = async (name: string, args: Record<string, unknown>) => {
  const { server } = await createServer();
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

  it('rejects an unknown id and a missing question', async () => {
    await expect(call('ask_elision', { elisionId: 'nope', question: 'x?' })).rejects.toThrow(/not found/);
    await expect(call('ask_elision', { elisionId: ID })).rejects.toThrow(/required/);
  });
});

describe('the elision marker names both ways back to the original', () => {
  it('mentions ask_elision next to expand_elision, and the no-MCP rewrite removes the whole clause', () => {
    const marker = formatElisionMarker('id1', 12, 3, 14);
    expect(marker).toContain('call expand_elision with this id and range {"startLine": 3, "endLine": 14} to retrieve, or ask_elision with this id and a question');
    const rewritten = rewriteElisionHint(marker);
    expect(rewritten).not.toContain('expand_elision');
    expect(rewritten).not.toContain('ask_elision');
  });
});
