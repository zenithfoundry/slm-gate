import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Markers, the gate's log and its ledger all go to a throwaway folder, never the real output/.
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-model-gate-'));
jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: { OUTPUT_DIR: outputDir, ROOT_DIR: process.cwd(), MODEL_GATE_PORT: 1 },
  CONFIG_ENV_KEYS: ['LEDGER_PATH', 'LLM_GATE_DISTILL'],
}));

const gate = await import('../../src/setup/model-gate.js');

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

const servers: http.Server[] = [];
async function serve(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  return listen(server);
}

afterAll(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  fs.rmSync(outputDir, { recursive: true, force: true });
});

describe('probeGate', () => {
  const entry = path.join(outputDir, 'server.js');
  let build: string;

  beforeAll(() => {
    fs.writeFileSync(entry, '');
    build = String(Math.round(fs.statSync(entry).mtimeMs));
  });

  const healthServer = (health: object) => serve((req, res) => {
    res.writeHead(req.url === gate.HEALTH_PATH ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health));
  });

  it('recognises a running gate started from the installed build', async () => {
    const port = await healthServer({ service: 'slm-gate', pid: 42, port: 0, entry, build, startedAt: 'now' });
    const probe = await gate.probeGate({ port });
    expect(probe).toMatchObject({ kind: 'slm-gate', stale: false, health: { pid: 42 } });
  });

  it('flags a running gate started from an older build', async () => {
    const port = await healthServer({ service: 'slm-gate', pid: 42, port: 0, entry, build: '1', startedAt: 'now' });
    expect(await gate.probeGate({ port })).toMatchObject({ kind: 'slm-gate', stale: true });
  });

  it('reports another program on the port as other', async () => {
    const port = await serve((_req, res) => { res.writeHead(404); res.end('<html>not found</html>'); });
    expect(await gate.probeGate({ port })).toEqual({ kind: 'other' });
  });

  it('reports a port nothing listens on as nothing', async () => {
    expect(await gate.probeGate({ port: await freePort() })).toEqual({ kind: 'nothing' });
  });
});

describe('gateEnvironment', () => {
  it('drops every variable slm-gate reads, so the gate takes its settings only from its own .env', () => {
    const env = gate.gateEnvironment({ LEDGER_PATH: '/tmp/x', LLM_GATE_DISTILL: 'off', PATH: '/bin', HOME: '/home/me' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me' });
  });
});

describe('launching and stopping a real gate', () => {
  let port: number;

  beforeAll(async () => {
    port = await freePort();
  });

  afterAll(async () => {
    await gate.stopModelGate({ port });
  });

  it('starts one gate however many sessions try at once, and stop keeps it stopped', async () => {
    const launch = () => gate.launchModelGate({
      port,
      execArgv: ['--import', 'tsx'],
      envOverrides: {
        LEDGER_PATH: path.join(outputDir, 'ledger.sqlite'),
        LLM_GATE_DISTILL: 'off',
        LLM_GATE_LOCAL_FIRST: 'off',
        LANGFUSE_PUBLIC_KEY: '',
        LANGFUSE_SECRET_KEY: '',
        LANGFUSE_HOST: '',
      },
    });

    const results = [launch(), launch(), launch()];
    expect(results.map(result => result.launched)).toEqual([true, false, false]);

    const health = await gate.waitForModelGate({ port, timeoutMs: 20_000 });
    expect(health).toMatchObject({ service: 'slm-gate', port });
    expect(gate.isStoppedByUser()).toBe(false);

    const stopped = await gate.stopModelGate({ port });
    expect(stopped?.pid).toBe(health?.pid);
    expect(await gate.probeGate({ port })).toEqual({ kind: 'nothing' });
    expect(gate.isStoppedByUser()).toBe(true);
    expect(fs.readFileSync(gate.GATE_LOG_FILE, 'utf8')).toContain(`LLM Gate running on port ${port}`);
  }, 40_000);
});

describe('the "stopped by you" marker', () => {
  const marker = path.join(outputDir, '.gate-stopped');
  const bootMinute = () => Math.round((Date.now() - os.uptime() * 1000) / 60_000);
  const hasOsBootId = process.platform === 'darwin' || process.platform === 'linux';

  afterAll(() => fs.rmSync(marker, { force: true }));

  (hasOsBootId ? it : it.skip)('keeps a stop in force when the clock jumps (keyed to the OS boot ID)', async () => {
    await gate.stopModelGate({ port: await freePort() });
    expect(fs.readFileSync(marker, 'utf8')).not.toMatch(/^\d+$/);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000);
    try {
      expect(gate.isStoppedByUser()).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('ends a stop recorded in an earlier boot', () => {
    fs.writeFileSync(marker, '00000000-0000-0000-0000-000000000000');
    expect(gate.isStoppedByUser()).toBe(false);
  });

  it('still honours a stop written by an older slm-gate (a boot minute)', () => {
    fs.writeFileSync(marker, String(bootMinute()));
    expect(gate.isStoppedByUser()).toBe(true);
  });
});
