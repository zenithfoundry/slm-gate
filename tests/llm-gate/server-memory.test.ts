/**
 * @fileoverview Conversation memory through the real model gate: a forwarded request's ledger row carries
 * `meta.memory` (numbers only), the forwarded bytes are identical with memory on, the fold reaches the brain
 * after the interval and the row appears, and the summary text is never in any event row.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { startFakeOllama } from './fake-ollama.js';

const ollama = await startFakeOllama();
let lastBody = '';
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => { lastBody = Buffer.concat(chunks).toString('utf8'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"type":"message"}'); });
});
await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()));

process.env.OLLAMA_HOST = ollama.url;
process.env.UPSTREAM_ANTHROPIC_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
process.env.SEMCACHE = 'off';
process.env.LLM_GATE_DISTILL = 'off';
process.env.CONVERSATION_MEMORY = 'on';
process.env.MEMORY_FOLD_INTERVAL_MS = '100';

const { getDb, listMemoryRows } = await import('../../src/ledger/index.js');
const gate: http.Server = (await import('../../src/llm-gate/server.js')).server;
let gatePort: number;

beforeAll(async () => {
  gatePort = await new Promise<number>(r => gate.listen(0, '127.0.0.1', () => r((gate.address() as AddressInfo).port)));
  getDb().prepare('DELETE FROM conversation_memory').run();
});
afterAll(async () => {
  gate.closeAllConnections(); upstream.closeAllConnections();
  await new Promise(r => gate.close(r)); await new Promise(r => upstream.close(r)); await ollama.close();
});

function send(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' }, agent: false }, res => {
      res.resume(); res.on('end', () => resolve(String(res.headers['x-correlation-id'])));
    });
    req.on('error', reject); req.end(raw);
  });
}
const meta = (id: string) => JSON.parse((getDb().prepare('SELECT meta FROM events WHERE request_id = ?').get(id) as { meta: string }).meta);

const raw = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, messages: [
  { role: 'user', content: [{ type: 'text', text: 'Memory server test: rename the dashboard card' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Which card?' }] },
  { role: 'user', content: [{ type: 'text', text: 'The savings card in src/dashboard/index.html' }] },
] });

describe('conversation memory through the model gate', () => {
  it('forwards the bytes unchanged and writes a numbers-only memory note on the row', async () => {
    // The fake brain answers a fold with a valid summary object.
    ollama.state.structured = JSON.stringify({ goal: 'Rename the savings card', decided: [], inPlay: ['src/dashboard/index.html'] });
    const id = await send(raw);
    expect(lastBody).toBe(raw);
    const m = meta(id);
    expect(m.memory).toEqual({ turns_known: 0, age_s: null });
    expect(JSON.stringify(m)).not.toContain('savings card');
  });

  it('folds after the interval, once this process is idle, and the row covers the whole history', async () => {
    await new Promise(r => setTimeout(r, 400));
    const rows = listMemoryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].turns).toBe(3);
    expect(rows[0].summary).toContain('savings card');
    const id = await send(raw);
    expect(meta(id).memory.turns_known).toBe(3);
    const events = getDb().prepare("SELECT meta FROM events WHERE layer='llm'").all() as { meta: string }[];
    for (const e of events) expect(e.meta ?? '').not.toContain('Rename the savings card');
  });
});
