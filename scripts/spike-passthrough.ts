/**
 * @fileoverview Slice 0 spike: a pass-through-only proxy that records what coding tools send.
 *
 * Point a coding tool at this server. Each request is forwarded byte-for-byte to the provider its
 * path belongs to, with the tool's own headers (its own login), and the response comes back
 * untouched and unbuffered, with no timeout. One JSON line per request is appended to
 * output/spike/requests.jsonl so the real paths, headers and streaming behaviour can be read back
 * before the gate is redesigned.
 *
 * Routing is the gate's own (resolveUpstream in src/llm-gate/forward.ts), so the spike can reach only
 * the endpoints the gate forwards. Any other path gets a 404; its log line still records that the tool
 * sent it.
 *
 * Nothing secret is written. Credential headers and the Gemini `key` query parameter are logged as
 * a shape (kind and length, no characters). Bodies are logged as a shape (keys, type counts, sizes),
 * never their text. Error bodies (status >= 400) are the one exception: their first 500 bytes are
 * kept, because they are the provider's own message and the spike needs them.
 *
 * Throwaway by design: after the Slice 0 report it either grows into Slice 1's forwarder or is deleted.
 *
 * Usage:  pnpm exec tsx scripts/spike-passthrough.ts
 *   SPIKE_PORT   listen port (default 8799)
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUpstream, SUPPORTED_PATHS } from '../src/llm-gate/forward.js';
import { isLocalRequest, listenOnThisComputer } from '../src/utils/local-only.js';

const PORT = Number(process.env.SPIKE_PORT || 8799);
const LOG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'output', 'spike', 'requests.jsonl');

// Never forwarded in either direction: they describe this hop, not the request.
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade']);
const SENSITIVE_HEADER = /auth|key|token|secret|cookie|session|account/i;
// Keys worth counting because the gate must carry them through unchanged.
const NOTABLE_KEYS = new Set([
  'cache_control', 'thoughtSignature', 'thought_signature', 'encrypted_content', 'signature',
  'tool_use_id', 'tool_call_id', 'tool_calls', 'call_id', 'functionCall', 'functionResponse', 'previous_response_id',
]);

/** Describes a credential without revealing any of its characters. */
function credentialShape(value: string): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  const token = bearer ? bearer[1] : value;
  const kind = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(token) ? 'jwt'
    : token.startsWith('sk-ant-oat') ? 'anthropic-oauth'
    : token.startsWith('sk-ant-api') ? 'anthropic-api-key'
    : token.startsWith('sk-') ? 'sk-key'
    : token.startsWith('AIza') ? 'google-api-key'
    : 'other';
  return `${bearer ? 'Bearer ' : ''}<${kind} len=${token.length}>`;
}

// Providers echo (part of) a rejected key in their error text, e.g. OpenAI's
// "Incorrect API key provided: sk-proj-****abcd". Error samples are scrubbed with this.
const CREDENTIAL_IN_TEXT = /(sk-[\w*-]+|AIza[\w*-]+|eyJ[\w.*-]+)/g;

function bearerIsJwt(headers: http.IncomingHttpHeaders): boolean {
  return credentialShape(String(headers.authorization ?? '')).startsWith('Bearer <jwt');
}

/** The login of an OpenAI-format request: the gate sends /v1/responses to the ChatGPT backend when either is true. */
function loginSignals(headers: http.IncomingHttpHeaders): { chatgptAccountIdHeader: boolean; bearerIsJwt: boolean } {
  return { chatgptAccountIdHeader: headers['chatgpt-account-id'] !== undefined, bearerIsJwt: bearerIsJwt(headers) };
}

function headersForLog(headers: http.IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    return [name, SENSITIVE_HEADER.test(name) ? credentialShape(text) : text];
  }));
}

function queryForLog(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries([...params].map(([name, value]) => [name, name === 'key' ? credentialShape(value) : value]));
}

function withoutHopByHop(headers: http.IncomingHttpHeaders, keep: string[] = []): http.OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name) || keep.includes(name)));
}

/** Keys, block/item type counts, role counts and notable-key counts of a JSON body. No text. */
function bodyShape(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return { bytes: 0 };
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return { bytes: raw.length, json: false };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { bytes: raw.length };

  const types: Record<string, number> = {};
  const roles: Record<string, number> = {};
  const keys: Record<string, number> = {};
  const bump = (counts: Record<string, number>, name: string) => { counts[name] = (counts[name] ?? 0) + 1; };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' && typeof value === 'string') bump(types, value);
      if (key === 'role' && typeof value === 'string') bump(roles, value);
      if (NOTABLE_KEYS.has(key)) bump(keys, key);
      walk(value);
    }
  };

  const top = json as Record<string, unknown>;
  // Tool schemas are full of JSON-Schema "type" keys; counting them would drown the block types.
  for (const [key, value] of Object.entries(top)) if (key !== 'tools') walk(value);

  return {
    bytes: raw.length,
    topLevelKeys: Object.keys(top),
    model: top.model,
    stream: top.stream,
    store: top.store,
    include: top.include,
    toolCount: Array.isArray(top.tools) ? top.tools.length : undefined,
    systemKind: Array.isArray(top.system) ? `array(${top.system.length})` : typeof top.system,
    types,
    roles,
    keys,
  };
}

/** Watches a response stream without altering it: timing, size, SSE event counts, error sample. */
function watchResponse(upstreamRes: http.IncomingMessage) {
  const started = Date.now();
  const contentType = String(upstreamRes.headers['content-type'] ?? '');
  const encoding = upstreamRes.headers['content-encoding'];
  const parseSse = contentType.includes('text/event-stream') && !encoding;
  const isError = (upstreamRes.statusCode ?? 0) >= 400;
  const stats = { bytes: 0, maxGapMs: 0, sseEvents: {} as Record<string, number>, sseDataLines: 0, errorSample: '' };
  let lastChunkAt = started;
  let carry = '';

  upstreamRes.on('data', (chunk: Buffer) => {
    const now = Date.now();
    stats.maxGapMs = Math.max(stats.maxGapMs, now - lastChunkAt);
    lastChunkAt = now;
    stats.bytes += chunk.length;
    if (isError && stats.errorSample.length < 500) stats.errorSample += chunk.toString('utf8').slice(0, 500 - stats.errorSample.length);
    if (!parseSse) return;
    const lines = (carry + chunk.toString('utf8')).split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        const name = line.slice('event:'.length).trim();
        stats.sseEvents[name] = (stats.sseEvents[name] ?? 0) + 1;
      } else if (line.startsWith('data:')) {
        stats.sseDataLines++;
      }
    }
  });

  return () => ({
    ...stats,
    errorSample: stats.errorSample.replace(CREDENTIAL_IN_TEXT, '<redacted>'),
    durationMs: Date.now() - started,
    contentType,
    contentEncoding: encoding ?? null,
  });
}

function writeLog(entry: Record<string, unknown>): void {
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  const res = entry.response as { status?: number; contentType?: string; durationMs?: number } | undefined;
  console.error(`[spike] ${entry.method} ${entry.path} -> ${entry.format ?? 'unrouted'} ${res?.status ?? entry.status} ${res?.contentType ?? ''} ${res?.durationMs ?? 0}ms`);
}

/** The redacted part of a log line that needs only the request line and headers. */
function requestSummary(req: http.IncomingMessage): Record<string, unknown> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return {
    ts: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: queryForLog(url.searchParams),
    headers: headersForLog(req.headers),
  };
}

function forward(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const entry: Record<string, unknown> = { ...requestSummary(req), body: bodyShape(body) };

  const route = resolveUpstream({ pathAndQuery: req.url ?? '/', headers: req.headers });
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `slm-gate spike: unsupported path ${url.pathname}`, supported: SUPPORTED_PATHS }));
    writeLog({ ...entry, status: 404 });
    return;
  }
  const openaiFormat = route.format === 'chat-completions' || route.format === 'responses';
  // No query: it can carry Gemini's `key`, which the log keeps only as a shape (see `query`).
  Object.assign(entry, {
    format: route.format,
    upstream: route.url.origin + route.url.pathname,
    loginSignals: openaiFormat ? loginSignals(req.headers) : undefined,
  });

  const requestStarted = Date.now();
  const headers = withoutHopByHop(req.headers);
  if (body.length > 0) headers['content-length'] = body.length;

  // Abort paths can fire several events for one request (client close, upstream error); log once.
  let logged = false;
  const logOnce = (outcome: Record<string, unknown>) => {
    if (logged) return;
    logged = true;
    writeLog({ ...entry, ...outcome });
  };

  const transport = route.url.protocol === 'https:' ? https : http;
  const upstreamReq = transport.request(route.url, { method: req.method, headers }, upstreamRes => {
    const ttfbMs = Date.now() - requestStarted;
    // content-length stays: the bytes are passed through unchanged, so it is still correct.
    res.writeHead(upstreamRes.statusCode ?? 502, withoutHopByHop(upstreamRes.headers, ['content-length']));
    const finish = watchResponse(upstreamRes);
    upstreamRes.pipe(res);
    upstreamRes.on('end', () => logOnce({ response: { status: upstreamRes.statusCode, ttfbMs, ...finish() } }));
    // Upstream dropped mid-stream, or we destroyed it after the client left. pipe() does not
    // forward source errors, and an unhandled one would crash the process.
    upstreamRes.on('error', err => {
      logOnce({ response: { status: upstreamRes.statusCode, ttfbMs, ...finish() }, streamError: err.message });
      res.destroy(err);
    });
  });

  upstreamReq.on('error', err => {
    // A dual-stack host refusing every address gives an AggregateError whose message is empty.
    const detail = err instanceof AggregateError ? err.errors.map(String).join('; ') : err.message;
    logOnce({ status: 502, upstreamError: detail });
    if (res.headersSent) {
      res.destroy(err);
    } else {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `slm-gate spike: upstream unreachable: ${detail}` }));
    }
  });

  // The tool gave up (Esc, timeout): stop the upstream generation too.
  res.on('close', () => {
    if (!res.writableFinished) {
      logOnce({ clientAborted: true, afterMs: Date.now() - requestStarted });
      upstreamReq.destroy();
    }
  });

  upstreamReq.end(body);
}

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

// The gate's rule: other machines cannot connect, and web pages cannot reach it through the browser.
listenOnThisComputer({
  handler: (req, res) => {
    if (!isLocalRequest(req.headers)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'slm-gate spike only accepts requests from programs on this computer' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => forward(req, res, Buffer.concat(chunks)));
    // Client dropped while still sending: nothing was forwarded, but the request still gets its one
    // log line. 'close' covers both a reset and a clean half-close; 'error' only needs swallowing.
    req.on('close', () => {
      if (req.complete) return;
      writeLog({ ...requestSummary(req), clientAbortedDuringUpload: true, bytesReceived: chunks.reduce((n, c) => n + c.length, 0) });
      res.destroy();
    });
    req.on('error', () => res.destroy());
  },
  port: PORT,
  onListening: () => console.error(`[spike] pass-through listening on http://localhost:${PORT} — logging to ${LOG_PATH}`),
}).catch(err => {
  console.error(`[spike] could not listen on port ${PORT}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
