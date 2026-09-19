import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { startFakeOllama } from './fake-ollama.js';

// The real gate, a fake Ollama and a mock provider. Config is read once at import, so both are running
// and the env is set before the gate modules load.
const ollama = await startFakeOllama();
let upstreamCalls = 0;
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    upstreamCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"from":"provider"}');
  });
});
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

process.env.OLLAMA_HOST = ollama.url;
process.env.UPSTREAM_ANTHROPIC_URL = upstreamUrl;
process.env.UPSTREAM_OPENAI_URL = `${upstreamUrl}/v1`;
process.env.UPSTREAM_GEMINI_URL = upstreamUrl;
process.env.LOCAL_ATTEMPT_BUDGET_MS = '1000';
process.env.SELF_CONSISTENCY_K = '1';
process.env.SEMCACHE = 'off';
process.env.ROUTING_TUNE = 'off';

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

function send(params: { path: string; body: unknown }): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, method: 'POST', path: params.path, headers: { 'content-type': 'application/json' }, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(params.body));
  });
}

function ledgerRow(requestId: unknown): { route: string; slm_model: string | null; in_tok: number; meta: any } {
  const row = getDb().prepare('SELECT route, slm_model, in_tok, meta FROM events WHERE request_id = ?').get(String(requestId)) as any;
  return { ...row, meta: JSON.parse(row.meta) };
}

const claudeFirst = (text: string, extra: object = {}) => ({
  model: 'claude-sonnet-5',
  stream: true,
  tools: [{ name: 'Bash' }, { name: 'Read' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>project notes</system-reminder>' }, { type: 'text', text }] }],
  ...extra,
});

describe('llm-gate Step A', () => {
  it('answers "Say hi" from Claude Code locally, in Anthropic events, without calling the provider', async () => {
    const before = upstreamCalls;
    const res = await send({ path: '/v1/messages?beta=true', body: claudeFirst('Say hi') });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['x-slm-gate-route']).toBe('defer_local');
    expect(res.text).toContain('"text":"Hi! How can I help you today?"');
    expect(res.text).toContain('event: message_stop');
    expect(upstreamCalls).toBe(before);
    const row = ledgerRow(res.headers['x-correlation-id']);
    expect(row).toMatchObject({ route: 'defer_local', slm_model: expect.any(String) });
    expect(row.in_tok).toBeGreaterThan(0);
    expect(row.meta).toMatchObject({ local_outcome: 'answered', local_attempted: 1, local_accepted: 1, category: 'short_factual', format: 'anthropic' });
  });

  it('answers in the other three formats too', async () => {
    const before = upstreamCalls;
    const chat = await send({ path: '/v1/chat/completions', body: { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'Say hi' }] } });
    const codex = await send({ path: '/v1/responses', body: { model: 'gpt-5.6-codex', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }] } });
    const geminiCli = await send({ path: '/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse', body: { contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }] } });

    expect(JSON.parse(chat.text).choices[0].message.content).toBe('Hi! How can I help you today?');
    expect(codex.text).toContain('event: response.completed');
    expect(geminiCli.text).toMatch(/^data: \{"candidates"/);
    expect(upstreamCalls).toBe(before);
  });

  it('sends a first request about the workspace to the provider without asking the local model', async () => {
    const before = upstreamCalls;
    const res = await send({ path: '/v1/messages', body: claudeFirst('Does src/config.ts export CONFIG?') });

    expect(JSON.parse(res.text)).toEqual({ from: 'provider' });
    expect(upstreamCalls).toBe(before + 1);
    expect(ollama.calls).toEqual([]);
    expect(ledgerRow(res.headers['x-correlation-id']).meta).toMatchObject({ local_outcome: 'declined', local_attempted: 0 });
  });

  it('sends structured-output requests, later requests and JSON-array Gemini streams to the provider', async () => {
    const before = upstreamCalls;
    await send({ path: '/v1/messages', body: claudeFirst('Say hi', { output_config: { format: { type: 'json_schema', schema: {} } } }) });
    await send({ path: '/v1/messages', body: { ...claudeFirst('Say hi'), messages: [...claudeFirst('x').messages, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Say hi' }] } });
    await send({ path: '/v1beta/models/gemini-3.1-pro:streamGenerateContent', body: { contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }] } });

    expect(upstreamCalls).toBe(before + 3);
    expect(ollama.calls).toEqual([]);
  });

  it('forwards a first request whose local answer runs over the budget, and records why', async () => {
    ollama.state.delayMs = 5000;
    const before = upstreamCalls;
    const res = await send({ path: '/v1/messages', body: claudeFirst('What is the capital of Japan?') });

    expect(JSON.parse(res.text)).toEqual({ from: 'provider' });
    expect(upstreamCalls).toBe(before + 1);
    expect(ledgerRow(res.headers['x-correlation-id']).meta).toMatchObject({ local_outcome: 'timeout' });
  });
});
