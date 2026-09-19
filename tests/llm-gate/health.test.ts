import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';

let gate: http.Server;
let gatePort: number;

beforeAll(async () => {
  gate = (await import('../../src/llm-gate/server.js')).server;
  await new Promise<void>(resolve => gate.listen(0, '127.0.0.1', resolve));
  gatePort = (gate.address() as AddressInfo).port;
});

afterAll(() => new Promise(resolve => gate.close(resolve)));

describe('GET /slm-gate/health', () => {
  it('is answered by the gate itself, naming the process, port and build', async () => {
    const res = await fetch(`http://127.0.0.1:${gatePort}/slm-gate/health`);
    expect(res.status).toBe(200);
    const health = await res.json() as Record<string, unknown>;
    expect(health).toMatchObject({ service: 'slm-gate', pid: process.pid, port: gatePort });
    expect(String(health.entry)).toMatch(/llm-gate[/\\]server\.(ts|js)$/);
    expect(health.build).toMatch(/^\d+$/);
    expect(health.models).toEqual(expect.arrayContaining([expect.objectContaining({ setting: 'SLM_GATE_MODEL' })]));
  });
});
