/**
 * @fileoverview Slice 1b through the real gate server: the ledger row of a forwarded Anthropic-format request
 * carries how many tool definitions it listed, how many were deferred, and the size of the rest; a request
 * without tools carries no such fields. A mock provider answers upstream; no local model is involved.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';

// Measurement only: tool-result shrinking (Step B) is not needed to count tool definitions.
process.env.LLM_GATE_DISTILL = 'false';

let upstream: http.Server;
let gate: http.Server;
let gatePort: number;
let getDb: typeof import('../../src/ledger/index.js').getDb;

/** Starts a server on a free loopback port and resolves with that port. */
function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
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

/** Posts one Anthropic-format request through the gate and resolves with its ledger request id. */
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

/** The parsed `meta` JSON of the ledger row the gate wrote for a request. */
const meta = (requestId: string): Record<string, unknown> =>
  JSON.parse((getDb().prepare('SELECT meta FROM events WHERE request_id = ?').get(requestId) as { meta: string }).meta);

/** A minimal Anthropic tool definition, optionally marked for server-side tool search. */
const tool = (name: string, deferred: boolean) => ({
  name, description: `The ${name} tool`, input_schema: { type: 'object', properties: {} }, ...(deferred ? { defer_loading: true } : {}),
});
const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];

describe('ledger row of a forwarded request: tool definitions in context', () => {
  it('records how many tools were listed, how many were deferred, and the size of the rest', async () => {
    const tools = [tool('Bash', false), tool('Read', false), ...Array.from({ length: 23 }, (_, i) => tool(`mcp__srv__t${i}`, true))];
    const id = await send({ model: 'claude-sonnet-5', max_tokens: 10, messages, tools });
    const row = meta(id);
    expect(row.tools_count).toBe(25);
    expect(row.tools_deferred).toBe(23);
    expect(row.tools_tok_est).toBeGreaterThan(0);
  });

  it('writes no tool fields for a request that lists no tools', async () => {
    const id = await send({ model: 'claude-sonnet-5', max_tokens: 10, messages });
    expect(meta(id)).not.toHaveProperty('tools_count');
  });
});
