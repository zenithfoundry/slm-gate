/**
 * @fileoverview `expand_elision` paging, and its ledger row (expansion accounting): the feedback event is written after
 * paging with the tokens of the exact returned text, and an expansion never asks Ollama for an embedding model.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// A tiny page budget so a 100-line document needs several pages.
jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    DOWNSTREAM_MCP: { command: 'echo' },
    MCP_GATE_TRANSPORT: 'stdio',
    DISTILL_MAX_TOKENS: 50,
    ELISION_RETENTION_DAYS: 180,
    ELISION_MAX_MB: 10,
    ELISION_MAX_ENTRIES: 5000,
  }
}));

jest.unstable_mockModule('../../src/mcp-gate/pipeline.js', () => ({
  conditionPrompt: jest.fn(async ({ text }: { text: string }) => text),
}));

// Expanding a region teaches the distiller via embeddings; no Ollama in tests.
jest.unstable_mockModule('../../src/utils/embedding.js', () => ({
  embedText: jest.fn(async () => null),
  float64ArrayToBuffer: jest.fn(),
  bufferToFloat64Array: jest.fn(),
  cosineSimilarity: jest.fn(() => 0),
}));

jest.unstable_mockModule('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(),
    request: jest.fn(async () => ({ tools: [] })),
    getInstructions: () => undefined,
  }))
}));

const { writeElision, getDb } = await import('../../src/ledger/index.js');
const { estimateTokens } = await import('../../src/utils/elision.js');
const embedding = await import('../../src/utils/embedding.js');
const { createServer } = await import('../../src/mcp-gate/server.js');

const lines = Array.from({ length: 100 }, (_, i) => `line ${i} of the original skill text`);
const ID = 'elision-under-test';

writeElision({
  id: ID,
  tool_name: 'get_skill',
  args: '{}',
  original_text: lines.join('\n'),
  ranges: JSON.stringify({ startLine: 0, endLine: 99 }),
  content_hash: 'hash',
  size_bytes: 1000,
});

const expand = async (range?: { startLine: number; endLine: number }): Promise<string> => {
  const { server } = await createServer();
  const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
  const result = await handler(
    { method: 'tools/call', params: { name: 'expand_elision', arguments: { elisionId: ID, range } } },
    {}
  );
  return result.content[0].text as string;
};

const nextRange = (text: string) => {
  const m = text.match(/range \{"startLine": (\d+), "endLine": (\d+)\}/);
  return m ? { startLine: Number(m[1]), endLine: Number(m[2]) } : undefined;
};

describe('expand_elision', () => {
  it('returns every requested line across pages, with no gap in the middle', async () => {
    const got: string[] = [];
    let range: { startLine: number; endLine: number } | undefined = { startLine: 10, endLine: 80 };
    for (let pages = 0; range && pages < 50; pages++) {
      const text = await expand(range);
      range = nextRange(text);
      got.push(...text.split('\n').filter(l => l.startsWith('line ')));
    }
    expect(range).toBeUndefined();
    expect(got).toEqual(lines.slice(10, 81));
  });

  it('points the next page at exactly the lines not returned yet', async () => {
    const text = await expand({ startLine: 10, endLine: 80 });
    const shown = text.split('\n').filter(l => l.startsWith('line ')).length;
    expect(nextRange(text)).toEqual({ startLine: 10 + shown, endLine: 80 });
  });

  it('returns a small range whole, with no marker', async () => {
    const text = await expand({ startLine: 3, endLine: 4 });
    expect(text).toBe(`${lines[3]}\n${lines[4]}`);
  });

  it('starts from the top of the original when no range is given', async () => {
    const text = await expand();
    expect(text.startsWith(lines[0])).toBe(true);
    expect(nextRange(text)?.endLine).toBe(99);
  });

  it('charges the feedback row with the tokens of the page actually returned, marker included', async () => {
    const text = await expand({ startLine: 10, endLine: 80 });
    const row = getDb().prepare("SELECT out_tok, in_tok, meta FROM events WHERE route = 'feedback' ORDER BY rowid DESC LIMIT 1").get() as { out_tok: number; in_tok: number; meta: string };
    expect(row.out_tok).toBe(estimateTokens(text));
    expect(row.out_tok).toBeGreaterThan(0);
    expect(row.in_tok).toBe(0);
    expect(JSON.parse(row.meta).page).toEqual({ start: 10, end: 80, next: nextRange(text)!.startLine });
  });

  it('answers a range that is not two numbers with an MCP error result instead of guessing', async () => {
    const { server } = await createServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const result = await handler(
      { method: 'tools/call', params: { name: 'expand_elision', arguments: { elisionId: ID, range: { startLine: '3', endLine: 4 } } } },
      {}
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/expand_elision: invalid arguments \(range\.startLine: /);
  });

  it('never asks for an embedding model on expansion, whatever the adaptive setting', async () => {
    await expand({ startLine: 0, endLine: 5 });
    expect(embedding.embedText).not.toHaveBeenCalled();
  });
});
