/**
 * @fileoverview The model gate reads a request body up to a fixed size and answers 413 past it, instead of
 * buffering whatever a client sends.
 */
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

afterAll(() => new Promise(resolve => { gate.closeAllConnections(); gate.close(resolve); }));

describe('request body limit', () => {
  it('answers 413 to a body over 32 MB without reading the rest', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: gatePort, method: 'POST', path: '/v1/messages', agent: false }, res => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      // The server cuts the connection after answering; that is not a failure of this test.
      req.on('error', () => {});
      req.setTimeout(10_000, () => reject(new Error('no answer')));
      const chunk = Buffer.alloc(1024 * 1024, 'x');
      for (let i = 0; i < 33; i++) req.write(chunk);
      req.end();
    });
    expect(status).toBe(413);
  // 33 MB through loopback can take longer than jest's 5 s default on a loaded machine.
  }, 30_000);
});
