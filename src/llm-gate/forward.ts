/**
 * @fileoverview Forwards a model request, unchanged, to the provider its wire format belongs to.
 *
 * The gate never translates between formats and never swaps credentials: every client header except
 * hop-by-hop ones goes upstream, so the tool keeps its own login (API key, claude.ai login, ChatGPT
 * login). Bytes pass through raw in both directions. That rules out `fetch`, which decompresses a
 * response but keeps its `content-encoding` header — Claude Code's streams arrive gzip-encoded.
 * There is no timeout and no retry: streams can run for many minutes, and every tool retries itself.
 */
import http from 'node:http';
import https from 'node:https';
import { CONFIG } from '../config.js';

export type WireFormat = 'anthropic' | 'chat-completions' | 'responses' | 'gemini';

export interface UpstreamRoute {
  format: WireFormat;
  url: URL;
  /** True for calls that produce a reply; false for hello pings, model lists and token counts. */
  generation: boolean;
  /** Gemini names the model in the path instead of the body. */
  pathModel?: string;
}

export interface ForwardOutcome {
  status: number;
  durationMs: number;
  bytesOut: number;
  clientAborted: boolean;
  error?: string;
}

/** Listed in the 404 a tool gets for any other path. */
export const SUPPORTED_PATHS = [
  'POST /v1/messages',
  'POST /v1/messages/count_tokens',
  'HEAD /api/hello',
  'GET /v1/models (with an anthropic-version header)',
  'POST /v1/chat/completions',
  'POST /v1/responses',
  'POST /v1beta/models/{model}:generateContent',
  'POST /v1beta/models/{model}:streamGenerateContent',
  'POST /v1beta/models/{model}:countTokens',
];

// Describe this hop, not the request, so they are never forwarded in either direction.
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer']);

// countTokens is included because Gemini CLI sends it for prompts that carry media.
const GEMINI_PATH = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/;

function upstreamUrl(params: { base: string; path: string; search: string }): URL {
  return new URL(params.base.replace(/\/+$/, '') + params.path + params.search);
}

/**
 * PROVISIONAL (Slice 0 finding F24, not yet confirmed against a real Codex ChatGPT login): a ChatGPT
 * login sends a ChatGPT access token, which is a JWT, plus a `chatgpt-account-id` header; an API-key
 * login sends an `sk-` key. Only the former may go to the ChatGPT backend.
 */
function isChatgptLogin(headers: http.IncomingHttpHeaders): boolean {
  if (headers['chatgpt-account-id'] !== undefined) return true;
  const token = /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? ''))?.[1] ?? '';
  return /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(token);
}

/**
 * Picks the upstream for a request from its path (and, where two formats share a path, its headers).
 *
 * @param params.pathAndQuery The request target as received, e.g. `/v1/messages?beta=true`
 * @param params.headers The client's request headers
 * @returns The route, or null when the gate does not handle that path
 */
export function resolveUpstream(params: { pathAndQuery: string; headers: http.IncomingHttpHeaders }): UpstreamRoute | null {
  const { pathAndQuery, headers } = params;
  const { pathname, search } = new URL(pathAndQuery, 'http://gate.local');
  const anthropic = (generation: boolean): UpstreamRoute =>
    ({ format: 'anthropic', url: upstreamUrl({ base: CONFIG.UPSTREAM_ANTHROPIC_URL, path: pathname, search }), generation });

  switch (pathname) {
    case '/v1/messages':
      return anthropic(true);
    case '/v1/messages/count_tokens':
    case '/api/hello':
      return anthropic(false);
    case '/v1/models':
      // OpenAI-format tools list models on the same path; only Anthropic clients send this header.
      return headers['anthropic-version'] === undefined ? null : anthropic(false);
    case '/v1/chat/completions':
      return { format: 'chat-completions', url: upstreamUrl({ base: CONFIG.UPSTREAM_OPENAI_URL, path: '/chat/completions', search }), generation: true };
    case '/v1/responses': {
      const base = isChatgptLogin(headers) ? CONFIG.UPSTREAM_CHATGPT_URL : CONFIG.UPSTREAM_OPENAI_URL;
      return { format: 'responses', url: upstreamUrl({ base, path: '/responses', search }), generation: true };
    }
  }

  const gemini = GEMINI_PATH.exec(pathname);
  if (!gemini) return null;
  return {
    format: 'gemini',
    url: upstreamUrl({ base: CONFIG.UPSTREAM_GEMINI_URL, path: pathname, search }),
    generation: gemini[2] !== 'countTokens',
    pathModel: gemini[1],
  };
}

function withoutHopByHop(headers: http.IncomingHttpHeaders, keep?: string): http.OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name) || name === keep));
}

/**
 * Sends the request upstream and pipes the response back as it arrives, without changing either.
 *
 * @param params.req The client request (its method and headers are forwarded)
 * @param params.res The client response; upstream status, headers and body are written to it
 * @param params.body The request body exactly as received
 * @param params.route Where to send it
 * @returns Resolves once the response has ended, failed, or the client has gone away
 */
export function forwardRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: Buffer;
  route: UpstreamRoute;
}): Promise<ForwardOutcome> {
  const { req, res, body, route } = params;
  const started = Date.now();
  const headers = withoutHopByHop(req.headers);
  if (body.length > 0) headers['content-length'] = body.length;
  const transport = route.url.protocol === 'https:' ? https : http;

  return new Promise(resolve => {
    let settled = false;
    let status = 0;
    let bytesOut = 0;
    const settle = (outcome: Partial<ForwardOutcome> = {}) => {
      if (settled) return;
      settled = true;
      resolve({ status, durationMs: Date.now() - started, bytesOut, clientAborted: false, ...outcome });
    };

    const upstreamReq = transport.request(route.url, { method: req.method, headers }, upstreamRes => {
      status = upstreamRes.statusCode ?? 502;
      // content-length stays: the bytes pass through unchanged, so it is still correct.
      res.writeHead(status, withoutHopByHop(upstreamRes.headers, 'content-length'));
      upstreamRes.on('data', (chunk: Buffer) => { bytesOut += chunk.length; });
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => settle());
      // The upstream dropped mid-stream, or was destroyed after the client left. pipe() does not
      // pass source errors on, and an unhandled one would crash the gate.
      upstreamRes.on('error', err => {
        settle({ error: err.message });
        res.destroy(err);
      });
    });

    upstreamReq.on('error', err => {
      // A dual-stack host refusing every address raises an AggregateError with an empty message.
      const detail = err instanceof AggregateError ? err.errors.map(String).join('; ') : err.message;
      settle({ status: 502, error: detail });
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { type: 'slm_gate_upstream_unreachable', message: `slm-gate could not reach ${route.url.origin}: ${detail}` },
      }));
    });

    // The tool gave up (Esc, its own timeout): stop the upstream generation too.
    res.on('close', () => {
      if (res.writableFinished) return;
      settle({ clientAborted: true });
      upstreamReq.destroy();
    });

    upstreamReq.end(body);
  });
}
