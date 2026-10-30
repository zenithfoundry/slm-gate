/**
 * @fileoverview The model gate gives up on a provider that never starts answering (502 with the reason), while
 * a reply whose headers have arrived streams to its end: only the headers are timed.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { forwardRequest } from '../../src/llm-gate/forward.js';

const servers: http.Server[] = [];
const listen = (server: http.Server) => new Promise<number>(resolve => {
  servers.push(server);
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});

let silentPort: number;
let slowPort: number;
let gatePort: number;

beforeAll(async () => {
  // Never answers: the socket stays open with no headers.
  silentPort = await listen(http.createServer(req => { req.resume(); }));
  // Headers at once, then a body in two parts, the second well after the headers timeout used below.
  slowPort = await listen(http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('first\n');
    setTimeout(() => res.end('second\n'), 400);
  }));
  // A gate that forwards every request to the upstream named in the x-upstream-port header, with a 200 ms headers timeout.
  gatePort = await listen(http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(`http://127.0.0.1:${req.headers['x-upstream-port']}/v1/messages`);
      void forwardRequest({ req, res, body: Buffer.concat(chunks), route: { format: 'anthropic', url, generation: true }, headersTimeoutMs: 200 });
    });
  }));
});

afterAll(async () => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
});

describe('upstream headers timeout', () => {
  it('answers 502 naming the wait when the provider never starts answering', async () => {
    const res = await fetch(`http://127.0.0.1:${gatePort}/v1/messages`, { method: 'POST', headers: { 'x-upstream-port': String(silentPort) }, body: '{}' });
    expect(res.status).toBe(502);
    const error = (await res.json() as { error: { type: string; message: string } }).error;
    expect(error.type).toBe('slm_gate_upstream_unreachable');
    expect(error.message).toMatch(/no response within 200 ms/);
  });

  it('lets a reply whose headers arrived stream past the timeout to its end', async () => {
    const res = await fetch(`http://127.0.0.1:${gatePort}/v1/messages`, { method: 'POST', headers: { 'x-upstream-port': String(slowPort) }, body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('first\nsecond\n');
  });
});
