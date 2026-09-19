import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import zlib from 'node:zlib';

/**
 * The gate is started for real against a local mock upstream. Upstream addresses come from config,
 * which is read once at import, so the mock is listening and the env is set before the gate modules
 * are imported. Gemini points at a closed port to exercise the unreachable-upstream path.
 */

interface Received {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const received: Received[] = [];
const SSE_BODY = zlib.gzipSync(Buffer.from(
  'event: message_start\ndata: {"type":"message_start"}\n\n' +
  'event: ping\ndata: {"type":"ping"}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'
));
let firstChunkSeen: () => void = () => {};
let upstreamEnded = false;
let upstreamSawClose: () => void = () => {};

async function mockUpstream(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
  const mode = req.headers['x-test-mode'];

  if (mode === 'error') {
    res.writeHead(401, { 'content-type': 'application/json', 'request-id': 'req_upstream_1' });
    res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
  } else if (mode === 'stream') {
    // Send half, then hold the rest until the client has seen the first half (or 2 s pass).
    // A gate that buffered would only deliver anything after the end.
    upstreamEnded = false;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    const half = Math.floor(SSE_BODY.length / 2);
    res.write(SSE_BODY.subarray(0, half));
    await Promise.race([
      new Promise<void>(resolve => (firstChunkSeen = resolve)),
      new Promise(resolve => setTimeout(resolve, 2000).unref()),
    ]);
    upstreamEnded = true;
    res.end(SSE_BODY.subarray(half));
  } else if (mode === 'hang') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\ndata: {"type":"ping"}\n\n');
    res.on('close', () => upstreamSawClose());
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ upstreamPath: req.url }));
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

let upstream: http.Server;
let gate: http.Server;
let gatePort: number;
let forward: typeof import('../../src/llm-gate/forward.js');
let getDb: typeof import('../../src/ledger/index.js').getDb;

beforeAll(async () => {
  upstream = http.createServer((req, res) => void mockUpstream(req, res));
  const base = `http://127.0.0.1:${await listen(upstream)}`;
  const closed = http.createServer();
  const closedPort = await listen(closed);
  await new Promise(resolve => closed.close(resolve));

  process.env.UPSTREAM_ANTHROPIC_URL = `${base}/anthropic`;
  process.env.UPSTREAM_OPENAI_URL = `${base}/openai/v1`;
  process.env.UPSTREAM_CHATGPT_URL = `${base}/chatgpt/codex`;
  process.env.UPSTREAM_GEMINI_URL = `http://127.0.0.1:${closedPort}/gemini`;

  forward = await import('../../src/llm-gate/forward.js');
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

/** A raw HTTP client: unlike fetch it never decompresses, so the exact bytes can be compared. */
function send(params: {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
  onFirstChunk?: () => void;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const { method = 'POST', path, headers = {}, body, onFirstChunk } = params;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, method, path, headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        if (chunks.length === 0) onFirstChunk?.();
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function lastReceived(): Received {
  return received[received.length - 1];
}

function ledgerRow(requestId: string): { route: string; api_model: string | null; meta: string } | undefined {
  return getDb().prepare('SELECT route, api_model, meta FROM events WHERE request_id = ?').get(requestId) as
    { route: string; api_model: string | null; meta: string } | undefined;
}

describe('resolveUpstream', () => {
  const route = (pathAndQuery: string, headers: http.IncomingHttpHeaders = {}) => forward.resolveUpstream({ pathAndQuery, headers });

  it('sends Anthropic Messages paths to the Anthropic upstream with the query kept', () => {
    const r = route('/v1/messages?beta=true');
    expect(r?.format).toBe('anthropic');
    expect(r?.url.href).toBe(`${process.env.UPSTREAM_ANTHROPIC_URL}/v1/messages?beta=true`);
    expect(r?.generation).toBe(true);
  });

  it('marks hello pings, token counts and model lists as auxiliary calls', () => {
    expect(route('/v1/messages/count_tokens')?.generation).toBe(false);
    expect(route('/api/hello')?.generation).toBe(false);
    expect(route('/v1/models', { 'anthropic-version': '2023-06-01' })?.generation).toBe(false);
    expect(route('/v1beta/models/gemini-3:countTokens')?.generation).toBe(false);
  });

  it('only treats /v1/models as Anthropic when an anthropic-version header is present', () => {
    expect(route('/v1/models')).toBeNull();
  });

  it('sends Chat Completions to the OpenAI API', () => {
    expect(route('/v1/chat/completions')?.url.href).toBe(`${process.env.UPSTREAM_OPENAI_URL}/chat/completions`);
  });

  it('sends Responses to the ChatGPT backend only for a ChatGPT login', () => {
    expect(route('/v1/responses', { authorization: 'Bearer sk-proj-abc' })?.url.href).toBe(`${process.env.UPSTREAM_OPENAI_URL}/responses`);
    expect(route('/v1/responses', { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln' })?.url.href)
      .toBe(`${process.env.UPSTREAM_CHATGPT_URL}/responses`);
    expect(route('/v1/responses', { 'chatgpt-account-id': 'acct' })?.url.href).toBe(`${process.env.UPSTREAM_CHATGPT_URL}/responses`);
  });

  it('keeps the Gemini path and query and reads the model from the path', () => {
    const r = route('/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse');
    expect(r?.format).toBe('gemini');
    expect(r?.url.href).toBe(`${process.env.UPSTREAM_GEMINI_URL}/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse`);
    expect(r?.pathModel).toBe('gemini-3.1-pro-preview');
  });

  it('returns null for paths the gate does not handle', () => {
    expect(route('/v1/embeddings')).toBeNull();
    expect(route('/v1beta/models/gemini-3:embedContent')).toBeNull();
  });
});

describe('llm-gate pass-through', () => {
  it('forwards the body byte-for-byte with the tool\'s own login headers', async () => {
    const body = Buffer.from('{"model":"claude-sonnet-5","stream":false,"messages":[{"role":"user","content":"hi"}]}');
    const res = await send({
      path: '/v1/messages?beta=true',
      headers: {
        authorization: 'Bearer sk-ant-oat01-test',
        'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
    });

    expect(res.status).toBe(200);
    const got = lastReceived();
    expect(got.url).toBe('/anthropic/v1/messages?beta=true');
    expect(got.body.equals(body)).toBe(true);
    expect(got.headers.authorization).toBe('Bearer sk-ant-oat01-test');
    expect(got.headers['anthropic-beta']).toBe('oauth-2025-04-20,interleaved-thinking-2025-05-14');
    expect(got.headers['anthropic-version']).toBe('2023-06-01');
    expect(got.headers['content-length']).toBe(String(body.length));
    expect(got.headers.host).toBe(new URL(process.env.UPSTREAM_ANTHROPIC_URL!).host);
  });

  it('streams a gzip-encoded SSE response back unchanged and without buffering it', async () => {
    let endedBeforeFirstChunk: boolean | undefined;
    const res = await send({
      path: '/v1/messages',
      headers: { 'x-test-mode': 'stream', 'accept-encoding': 'gzip' },
      body: Buffer.from('{}'),
      onFirstChunk: () => {
        endedBeforeFirstChunk = upstreamEnded;
        firstChunkSeen();
      },
    });

    expect(endedBeforeFirstChunk).toBe(false);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body.equals(SSE_BODY)).toBe(true);
  });

  it('returns an upstream error status, headers and body unchanged', async () => {
    const res = await send({ path: '/v1/messages', headers: { 'x-test-mode': 'error' }, body: Buffer.from('{}') });

    expect(res.status).toBe(401);
    expect(res.headers['request-id']).toBe('req_upstream_1');
    expect(res.body.toString()).toBe('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
  });

  it('routes a Responses request by login', async () => {
    await send({ path: '/v1/responses', headers: { authorization: 'Bearer sk-proj-abc' }, body: Buffer.from('{}') });
    expect(lastReceived().url).toBe('/openai/v1/responses');

    await send({ path: '/v1/responses', headers: { 'chatgpt-account-id': 'acct', authorization: 'Bearer token' }, body: Buffer.from('{}') });
    expect(lastReceived().url).toBe('/chatgpt/codex/responses');
  });

  it('writes one ledger row for a generation request and none for a hello ping', async () => {
    const res = await send({ path: '/v1/chat/completions', body: Buffer.from('{"model":"gpt-5.6-sol","messages":[]}') });
    const row = ledgerRow(String(res.headers['x-correlation-id']));
    expect(row?.route).toBe('forward_raw');
    expect(row?.api_model).toBe('gpt-5.6-sol');
    expect(JSON.parse(row!.meta)).toMatchObject({ format: 'chat-completions', path: '/v1/chat/completions', status: 200 });

    const hello = await send({ method: 'HEAD', path: '/api/hello' });
    expect(hello.status).toBe(200);
    expect(lastReceived().url).toBe('/anthropic/api/hello');
    expect(ledgerRow(String(hello.headers['x-correlation-id']))).toBeUndefined();
  });

  it('answers an unsupported path with a 404 naming the supported paths, and records it', async () => {
    const before = received.length;
    const res = await send({ path: '/v1/embeddings', body: Buffer.from('{}') });

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString()).error.supported).toEqual(forward.SUPPORTED_PATHS);
    expect(received.length).toBe(before);
    expect(JSON.parse(ledgerRow(String(res.headers['x-correlation-id']))!.meta)).toMatchObject({ status: 404, path: '/v1/embeddings' });
  });

  it('stops the upstream request when the client goes away mid-stream', async () => {
    const upstreamClosed = new Promise<void>(resolve => (upstreamSawClose = resolve));
    const req = http.request({ host: '127.0.0.1', port: gatePort, method: 'POST', path: '/v1/messages', headers: { 'x-test-mode': 'hang' }, agent: false }, res => {
      res.once('data', () => req.destroy());
    });
    req.on('error', () => {});
    req.end('{}');

    await expect(upstreamClosed).resolves.toBeUndefined();
  });

  it('answers 502 with the connection error when the upstream cannot be reached', async () => {
    const res = await send({ path: '/v1beta/models/gemini-3:generateContent', body: Buffer.from('{}') });

    expect(res.status).toBe(502);
    const error = JSON.parse(res.body.toString()).error;
    expect(error.type).toBe('slm_gate_upstream_unreachable');
    expect(error.message).toMatch(/ECONNREFUSED/);
  });
});
