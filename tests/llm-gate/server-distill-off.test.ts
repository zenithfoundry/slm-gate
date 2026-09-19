import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';

// The kill switch; read once when config is imported.
process.env.LLM_GATE_DISTILL = 'false';

let lastBody = '';
let upstream: http.Server;
let gate: http.Server;
let gatePort: number;

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
      res.end('{}');
    });
  });
  process.env.UPSTREAM_ANTHROPIC_URL = `http://127.0.0.1:${await listen(upstream)}`;
  gate = (await import('../../src/llm-gate/server.js')).server;
  gatePort = await listen(gate);
});

afterAll(async () => {
  gate.closeAllConnections();
  upstream.closeAllConnections();
  await new Promise(resolve => gate.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
});

describe('llm-gate with LLM_GATE_DISTILL off', () => {
  it('forwards the original bytes even when a large command result could be distilled', async () => {
    const log = Array.from({ length: 300 }, (_, i) => `step ${i} ok`).join('\n');
    // Irregular spacing on purpose: re-serialising would change these bytes.
    const raw = `{ "model":"claude-sonnet-5",  "messages":[{"role":"user","content":"go"},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"make"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":${JSON.stringify(log)}}]}] }`;

    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: gatePort, method: 'POST', path: '/v1/messages', agent: false }, res => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end(raw);
    });

    expect(lastBody).toBe(raw);
  });
});
