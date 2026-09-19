import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';

// The distiller's rules shrink these logs without the local model; the fake guarantees no Ollama call.
// classify and checkAgreement are imported through Step A; these requests are never first requests, so
// neither is called.
jest.unstable_mockModule('../../src/models/reasoning.js', () => ({
  compressNarrativeRun: jest.fn(async () => 'summary'),
  classify: jest.fn(async () => 'other'),
  checkAgreement: jest.fn(() => null),
}));

let lastBody = '';
let upstream: http.Server;
let gate: http.Server;
let gatePort: number;
let getDb: typeof import('../../src/ledger/index.js').getDb;

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"type":"message"}');
    });
  });
  process.env.UPSTREAM_ANTHROPIC_URL = `http://127.0.0.1:${await listen(upstream)}`;
  ({ getDb } = await import('../../src/ledger/index.js'));
  gate = (await import('../../src/llm-gate/server.js')).server;
  gatePort = await listen(gate);
});

afterAll(async () => {
  gate.closeAllConnections();
  upstream.closeAllConnections();
  await new Promise(resolve => gate.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
});

function send(body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' }, agent: false }, res => {
      res.resume();
      res.on('end', () => resolve(String(res.headers['x-correlation-id'])));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const testLog = Array.from({ length: 300 }, (_, i) => (i === 150 ? 'Error: expected 2 to equal 3 at sum.test.ts:12' : `  ✓ case ${i} passes in ${i % 7}ms`)).join('\n');
const first = { role: 'user', content: [{ type: 'text', text: `server distill test ${Date.now()}` }] };
const turn1 = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: testLog }] },
];
const turn2 = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'git status' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'nothing to commit' }] },
];

function ledgerRow(requestId: string): { route: string; api_in_tok: number; meta: string } {
  return getDb().prepare('SELECT route, api_in_tok, meta FROM events WHERE request_id = ?').get(requestId) as { route: string; api_in_tok: number; meta: string };
}

describe('llm-gate with distillation on', () => {
  it('forwards a large new command result distilled, and keeps it byte-identical as the conversation grows', async () => {
    const request1 = { model: 'claude-sonnet-5', tools: [{ name: 'Bash' }], messages: [first, ...turn1] };
    const id1 = await send(request1);
    const forwarded1 = JSON.parse(lastBody);
    const distilled: string = forwarded1.messages[2].content[0].content;

    expect(distilled.length).toBeLessThan(testLog.length / 2);
    expect(distilled).toContain('Error: expected 2 to equal 3');
    expect(distilled).toContain('not shown by slm-gate');
    expect(lastBody).toBe(JSON.stringify(request1).replace(JSON.stringify(testLog), JSON.stringify(distilled)));

    const row1 = ledgerRow(id1);
    expect(row1.route).toBe('forward_compressed');
    const meta1 = JSON.parse(row1.meta);
    expect(meta1.raw_in_tok).toBeGreaterThan(row1.api_in_tok);
    expect(meta1.distill).toMatchObject({ distilled: 1 });

    const id2 = await send({ model: 'claude-sonnet-5', tools: [{ name: 'Bash' }], messages: [first, ...turn1, ...turn2] });
    const forwarded2 = JSON.parse(lastBody);

    expect(forwarded2.messages[2].content[0].content).toBe(distilled);
    expect(JSON.parse(ledgerRow(id2).meta).distill).toMatchObject({ reused: 1, distilled: 0 });
  });
});
