import { afterAll, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { startFakeOllama } from './fake-ollama.js';

// The Step A kill switch; read once when config is imported.
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
process.env.OLLAMA_HOST = ollama.url;
process.env.UPSTREAM_ANTHROPIC_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
process.env.LLM_GATE_LOCAL_FIRST = 'false';

const gate: http.Server = (await import('../../src/llm-gate/server.js')).server;
const gatePort = await new Promise<number>(resolve => gate.listen(0, '127.0.0.1', () => resolve((gate.address() as AddressInfo).port)));

afterAll(async () => {
  gate.closeAllConnections();
  upstream.closeAllConnections();
  await new Promise(resolve => gate.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
  await ollama.close();
});

describe('llm-gate with LLM_GATE_LOCAL_FIRST off', () => {
  it('forwards a first request the local model would otherwise answer', async () => {
    const text = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: gatePort, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' }, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'Say hi' }] }));
    });

    expect(JSON.parse(text)).toEqual({ from: 'provider' });
    expect(upstreamCalls).toBe(1);
    expect(ollama.calls).toEqual([]);
  });
});
