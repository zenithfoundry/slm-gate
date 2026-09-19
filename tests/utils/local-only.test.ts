import { afterEach, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { isLocalRequest, listenOnThisComputer } from '../../src/utils/local-only.js';

describe('isLocalRequest', () => {
  it.each(['localhost:8787', '127.0.0.1:8787', '[::1]:8787', 'LOCALHOST:8787', 'localhost'])('accepts a request addressed to %s', host => {
    expect(isLocalRequest({ host })).toBe(true);
  });

  it.each(['evil.test:8787', '192.168.1.5:8787', 'localhost.:8787', '127.0.0.1.evil.test:8787'])('refuses a request addressed to %s', host => {
    expect(isLocalRequest({ host })).toBe(false);
  });

  it('refuses a request with no Host header', () => {
    expect(isLocalRequest({})).toBe(false);
  });

  it('accepts a web page served from this computer', () => {
    expect(isLocalRequest({ host: 'localhost:8787', origin: 'http://localhost:3000' })).toBe(true);
    expect(isLocalRequest({ host: 'localhost:8787', origin: 'http://[::1]:3000' })).toBe(true);
  });

  it.each(['https://evil.test', 'null', 'http://127.0.0.1.evil.test', 'file:///tmp/page.html'])('refuses a web page from %s', origin => {
    expect(isLocalRequest({ host: 'localhost:8787', origin })).toBe(false);
  });
});

/** Resolves true when something accepts a TCP connection at host:port. */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port, timeout: 1000 }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

const lanAddress = Object.values(os.networkInterfaces()).flat()
  .find(address => address && address.family === 'IPv4' && !address.internal)?.address;
const ipv6Loopback = Object.values(os.networkInterfaces()).flat().some(address => address?.address === '::1');

describe('listenOnThisComputer', () => {
  let servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    servers = [];
  });

  it('is reachable on both loopback addresses, on one port', async () => {
    servers = await listenOnThisComputer({ handler: (_req, res) => res.end('ok'), port: 0 });
    const port = (servers[0].address() as net.AddressInfo).port;
    expect(await canConnect('127.0.0.1', port)).toBe(true);
    if (ipv6Loopback) expect(await canConnect('::1', port)).toBe(true);
  });

  (lanAddress ? it : it.skip)('is not reachable at this computer\'s network address', async () => {
    servers = await listenOnThisComputer({ handler: (_req, res) => res.end('ok'), port: 0 });
    const port = (servers[0].address() as net.AddressInfo).port;
    expect(await canConnect(lanAddress!, port)).toBe(false);
  });

  it('fails on a port another loopback-only server holds (what doctor\'s port check relies on)', async () => {
    servers = await listenOnThisComputer({ handler: () => {}, port: 0 });
    const port = (servers[0].address() as net.AddressInfo).port;
    await expect(listenOnThisComputer({ handler: () => {}, port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('fails, leaving nothing listening, when the port is already taken', async () => {
    const holder = http.createServer();
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve));
    const port = (holder.address() as net.AddressInfo).port;
    try {
      await expect(listenOnThisComputer({ handler: () => {}, port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      if (ipv6Loopback) expect(await canConnect('::1', port)).toBe(false);
    } finally {
      await new Promise(resolve => holder.close(resolve));
    }
  });
});
