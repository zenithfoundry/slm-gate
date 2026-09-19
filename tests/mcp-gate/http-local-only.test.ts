import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';

// Standalone MCP server in HTTP mode on a free port; no toolbox, no local model.
jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: { DOWNSTREAM_MCP: null, MCP_GATE_TRANSPORT: 'http', MCP_GATE_PORT: 0 },
}));
jest.unstable_mockModule('../../src/mcp-gate/pipeline.js', () => ({
  conditionPrompt: jest.fn(async (text: string) => text),
}));

const { createServer } = await import('../../src/mcp-gate/server.js');

let servers: http.Server[] = [];
let port: number;

beforeAll(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  servers = await (await createServer()).start();
  port = (servers[0].address() as AddressInfo).port;
});

afterAll(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
});

const initialize = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
});

function post(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    }, res => {
      resolve(res.statusCode ?? 0);
      res.destroy();
    });
    req.on('error', reject);
    req.end(initialize);
  });
}

describe('the MCP server in HTTP mode serves only programs on this computer', () => {
  it('refuses a request addressed to another name (DNS rebinding)', async () => {
    expect(await post({ host: 'evil.test:8788' })).toBe(403);
  });

  it('refuses a request from a web page on another site', async () => {
    expect(await post({ host: 'localhost:8788', origin: 'https://evil.test' })).toBe(403);
  });

  it('serves an MCP client on this computer', async () => {
    expect(await post({ host: `127.0.0.1:${port}` })).toBe(200);
  });
});
