import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { startFakeOllama } from './fake-ollama.js';

// The real gate, a fake Ollama and a mock provider. Config is read once at import, so both are running
// and the env is set before the gate modules load. Step A is off so every typed turn reaches slice 3c.
const ollama = await startFakeOllama();
let lastBody = '';
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    lastBody = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"from":"provider"}');
  });
});
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));

process.env.OLLAMA_HOST = ollama.url;
process.env.UPSTREAM_ANTHROPIC_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
process.env.LLM_GATE_LOCAL_FIRST = 'off';
process.env.LLM_GATE_DISTILL = 'off';
process.env.ROUTING_TUNE = 'on';

const { getDb } = await import('../../src/ledger/index.js');
const gate: http.Server = (await import('../../src/llm-gate/server.js')).server;
let gatePort: number;

beforeAll(async () => {
  gatePort = await new Promise<number>(resolve => gate.listen(0, '127.0.0.1', () => resolve((gate.address() as AddressInfo).port)));
});

afterAll(async () => {
  gate.closeAllConnections();
  upstream.closeAllConnections();
  await new Promise(resolve => gate.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
  await ollama.close();
});

beforeEach(() => ollama.reset());

function send(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' }, agent: false }, res => {
      res.resume();
      res.on('end', () => resolve(String(res.headers['x-correlation-id'])));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

// The row is written once the classification settles, up to TURN_CLASSIFY_CAP_MS after the response ended.
async function meta(requestId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const row = getDb().prepare('SELECT meta FROM events WHERE request_id = ?').get(requestId) as { meta: string } | undefined;
    if (row) return JSON.parse(row.meta);
    if (Date.now() > deadline) throw new Error(`no ledger row for ${requestId} within 4 s`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const earlier = [
  { role: 'user', content: [{ type: 'text', text: 'What does this repository build?' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'A local gate.' }] },
];
const typedTurn = (text: string) => JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, messages: [...earlier, { role: 'user', content: [{ type: 'text', text }] }] });
const toolResultTurn = JSON.stringify({
  model: 'claude-sonnet-5', max_tokens: 10, messages: [
    ...earlier,
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'README.md' }] },
  ],
});

describe('per-turn classification for ROUTING_TUNE (slice 3c)', () => {
  it('classifies a later typed turn with the gate model and leaves the forwarded bytes untouched', async () => {
    const raw = typedTurn('Which of these two approaches is simpler to maintain?');
    const id = await send(raw);
    const row = await meta(id);
    expect(row.category).toBe('short_factual');
    expect(row.category_outcome).toBe('ok');
    expect(ollama.calls.map(c => c.kind)).toEqual(['classify']);
    expect(lastBody).toBe(raw);
  });

  it('skips a tool-result turn without a model call', async () => {
    const id = await send(toolResultTurn);
    expect((await meta(id)).category_outcome).toBe('skipped');
    expect(ollama.calls).toHaveLength(0);
  });

  it('skips a short typed turn without a model call', async () => {
    const id = await send(typedTurn('yes'));
    expect((await meta(id)).category_outcome).toBe('skipped');
    expect(ollama.calls).toHaveLength(0);
  });

  it('records a timeout, cancels the model call and still writes the row when the classifier is slow', async () => {
    ollama.state.classifyDelayMs = 10_000;
    const id = await send(typedTurn('Please explain the trade-off between the two options in detail.'));
    const row = await meta(id);
    expect(row.category).toBeNull();
    expect(row.category_outcome).toBe('timeout');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(ollama.calls[0]?.aborted).toBe(true);
  }, 10_000);
});
