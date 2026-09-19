import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';

let upstreamHits = 0;
let upstream: http.Server;
let gate: http.Server;
let gatePort: number;

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** Sends a request to the gate with the given headers (Host included) and returns the status. */
function send(params: { method: string; path: string; headers: Record<string, string> }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, method: params.method, path: params.path, headers: params.headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(params.method === 'POST' ? '{"model":"m","messages":[{"role":"user","content":"hi"}]}' : undefined);
  });
}

beforeAll(async () => {
  upstream = http.createServer((_req, res) => { upstreamHits++; res.writeHead(200); res.end('{}'); });
  process.env.UPSTREAM_ANTHROPIC_URL = `http://127.0.0.1:${await listen(upstream)}`;
  gate = (await import('../../src/llm-gate/server.js')).server;
  gatePort = await listen(gate);
});

afterAll(async () => {
  await new Promise(resolve => gate.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
});

describe('the model gate serves only programs on this computer', () => {
  const post = { method: 'POST', path: '/v1/messages' };
  const json = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };

  it('refuses a request addressed to another name (DNS rebinding) and forwards nothing', async () => {
    expect(await send({ ...post, headers: { ...json, host: 'evil.test:8787' } })).toBe(403);
    expect(upstreamHits).toBe(0);
  });

  it('refuses a request from a web page on another site and forwards nothing', async () => {
    expect(await send({ ...post, headers: { ...json, host: 'localhost:8787', origin: 'https://evil.test' } })).toBe(403);
    expect(upstreamHits).toBe(0);
  });

  it('refuses a cross-site preflight, and answers one from a page on this computer', async () => {
    expect(await send({ method: 'OPTIONS', path: '/v1/messages', headers: { host: 'localhost:8787', origin: 'https://evil.test' } })).toBe(403);
    expect(await send({ method: 'OPTIONS', path: '/v1/messages', headers: { host: 'localhost:8787', origin: 'http://localhost:3000' } })).toBe(204);
  });

  it('still answers its health check to a program on this computer', async () => {
    expect(await send({ method: 'GET', path: '/slm-gate/health', headers: { host: `127.0.0.1:${gatePort}` } })).toBe(200);
    expect(await send({ method: 'GET', path: '/slm-gate/health', headers: { host: 'evil.test' } })).toBe(403);
  });
});
