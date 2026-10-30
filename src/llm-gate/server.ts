/**
 * The model gate's HTTP server: receives a coding tool's provider request on this computer, distils the
 * tool results in its body (distill.ts), forwards it to the provider the wire format belongs to
 * (forward.ts), streams the answer back and writes the ledger row. Answers the health path itself.
 */
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';
import { readMemoryRow, writeEvent } from '../ledger/index.js';
import { log } from '../log.js';
import { estimateTokens } from '../utils/elision.js';
import { DistillStats, distilRequest } from './distill.js';
import * as anthropic from './formats/anthropic.js';
import * as chatCompletions from './formats/chat-completions.js';
import { conversationDiscriminator, conversationKey, JsonObject, ToolStats, WireFormatModule } from './formats/contract.js';
import * as gemini from './formats/gemini.js';
import * as responses from './formats/responses.js';
import { ForwardOutcome, forwardRequest, resolveUpstream, SUPPORTED_PATHS, UpstreamRoute, WireFormat } from './forward.js';
import { noteTurn } from './memory.js';
import { requestBodyProblem } from './request-schema.js';
import { asRequest } from '../models/busy.js';
import { HEALTH_PATH } from '../setup/model-gate.js';
import { requiredModels } from '../setup/local-models.js';
import { isLocalRequest } from '../utils/local-only.js';

const FORMATS: Record<WireFormat, WireFormatModule> = {
  anthropic,
  'chat-completions': chatCompletions,
  responses,
  gemini,
};

// The answer to "is the model gate running, and which one?" (HEALTH_PATH) — answered here, never
// forwarded. Read once at start and frozen: when this file on disk later has another modification time,
// the running gate is older than the installed build (see src/setup/model-gate.ts).
const SERVER_FILE = fileURLToPath(import.meta.url);
const HEALTH = {
  service: 'slm-gate',
  pid: process.pid,
  entry: SERVER_FILE,
  build: String(Math.round(fs.statSync(SERVER_FILE).mtimeMs)),
  startedAt: new Date().toISOString(),
  // So the MCP servers also check the models the gate's own settings (slm-gate's .env) name.
  models: requiredModels(),
  // So the dashboard, which may run from another install, can tell it is reading a different history.
  ledger: CONFIG.LEDGER_PATH,
};

/**
 * The largest request body the gate reads. A provider request with a long history and many tool results runs
 * to a few MB; past this the body is refused (413) instead of being buffered without bound.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function generateId(): string {
  return 'req_' + Math.random().toString(36).substring(2, 15);
}

/** The model a request is for: Gemini names it in the path, the other formats in the body. */
function requestModel(route: UpstreamRoute, parsed: JsonObject | null): string | undefined {
  if (route.pathModel) return route.pathModel;
  const model = parsed?.model;
  return typeof model === 'string' ? model : undefined;
}

function parseJsonObject(body: Buffer): JsonObject | null {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Step B: the bytes to forward. The original bytes go out whenever nothing changed, the body is not
 * JSON, or distillation fails in any way — it can make a request smaller, never break it.
 */
async function distilBody(params: { route: UpstreamRoute; parsed: JsonObject | null; body: Buffer }): Promise<{ sent: Buffer; distill: DistillStats | null }> {
  const { route, parsed, body } = params;
  if (!parsed) return { sent: body, distill: null };
  try {
    const result = await distilRequest({ format: FORMATS[route.format], body: parsed });
    return { sent: result.body ? Buffer.from(JSON.stringify(result.body)) : body, distill: result.stats };
  } catch (err) {
    log.warn('llm-gate', 'distillation skipped for this request', { error: err });
    return { sent: body, distill: null };
  }
}

/**
 * Writes the ledger row for a forwarded generation request or a rejected path. Hello pings, model
 * lists and token counts get no row, so they never count as model work in the metrics.
 */
function recordRequest(params: {
  reqId: string;
  path: string;
  body: Buffer;
  /** The body as JSON, parsed once by the caller; null when it is not a JSON object. */
  parsed?: JsonObject | null;
  route: UpstreamRoute | null;
  outcome: Pick<ForwardOutcome, 'status'> & Partial<ForwardOutcome>;
  /** What was forwarded, when Step B changed the body. */
  sent?: Buffer;
  distill?: DistillStats | null;
  /** Tool-definition counts of the request, when its format has them. */
  tools?: ToolStats | null;
  /** The conversation memory's state for this request (numbers only). */
  memory?: MemoryNote | null;
}): void {
  recordSafely({ reqId: params.reqId, path: params.path, write: () => writeLedgerRow(params) });
}

function recordSafely(params: { reqId: string; path: string; write: () => void }): void {
  try {
    params.write();
  } catch (err) {
    // Telemetry must never hold up model traffic: the row is lost, the request is not.
    log.error('llm-gate', `ledger row for ${params.reqId} (${params.path}) not written`, { error: err });
  }
}

function writeLedgerRow(params: Parameters<typeof recordRequest>[0]): void {
  const { reqId, path, body, parsed = null, route, outcome, distill = null, tools = null, memory = null } = params;
  const sent = params.sent ?? body;
  const distilled = sent !== body;
  writeEvent({
    ts: new Date().toISOString(),
    layer: 'llm',
    request_id: reqId,
    route: distilled ? 'forward_compressed' : 'forward_raw',
    is_local_call: 0,
    api_model: route ? requestModel(route, parsed) : undefined,
    in_tok: 0,
    out_tok: 0,
    // Estimated from the bodies until provider usage is read from responses.
    api_in_tok: route ? estimateTokens(sent.toString('utf8')) : 0,
    api_out_tok: 0,
    cost_usd: 0,
    slm_latency_s: 0,
    api_latency_s: (outcome.durationMs ?? 0) / 1000,
    slm_gate: 'on',
    meta: JSON.stringify({
      // Conversation memory: how much of this conversation the summary covers and how old it is. Never the text.
      ...(memory ? { memory } : {}),
      format: route?.format ?? null,
      path,
      status: outcome.status,
      bytes_in: body.length,
      bytes_sent: sent.length,
      bytes_out: outcome.bytesOut ?? 0,
      client_aborted: outcome.clientAborted ? 1 : 0,
      upstream_error: outcome.error ?? null,
      tokens_estimated: 1,
      // The metrics read raw_in_tok as "input before distillation" on forward_compressed rows.
      ...(distilled ? { raw_in_tok: estimateTokens(body.toString('utf8')) } : {}),
      // Tool definitions carried by the request (dashboard card "Tool definitions in context").
      ...(tools ? { tools_count: tools.count, tools_deferred: tools.deferred, tools_tok_est: tools.tokEst } : {}),
      distill,
    }),
  });
}

async function handleRequest(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  reqId: string;
  body: Buffer;
}): Promise<void> {
  // Counted as in flight until it returns, so background work (the memory fold) never overlaps a request and
  // a shutdown waits for it (src/shutdown.ts).
  await asRequest(() => handleRequestInner(params));
}

async function handleRequestInner(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  reqId: string;
  body: Buffer;
}): Promise<void> {
  const { req, res, reqId, body } = params;
  const path = new URL(req.url || '/', 'http://gate.local').pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('x-correlation-id', reqId);

  if (req.method === 'GET' && path === HEALTH_PATH) {
    const address = req.socket.localPort;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...HEALTH, port: address }));
    return;
  }

  const route = resolveUpstream({ pathAndQuery: req.url || '/', headers: req.headers });
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { type: 'slm_gate_unsupported_path', message: `slm-gate does not handle ${req.method} ${path}`, supported: SUPPORTED_PATHS },
    }));
    log.info('llm-gate', `${req.method} ${path} -> 404 (unsupported path)`);
    recordRequest({ reqId, path, body, route, outcome: { status: 404 } });
    return;
  }

  const parsed = route.generation ? parseJsonObject(body) : null;
  // A generation body the gate cannot read (not JSON, no history, no model) is refused here with the reason,
  // rather than forwarded for the provider to reject or failing somewhere in distillation.
  const problem = route.generation ? requestBodyProblem({ format: route.format, body: parsed }) : null;
  if (problem) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { type: 'slm_gate_invalid_request', message: `slm-gate cannot forward this ${route.format} request: ${problem}` },
    }));
    log.info('llm-gate', `${req.method} ${path} -> 400`, { reason: problem });
    recordRequest({ reqId, path, body, parsed, route, outcome: { status: 400 } });
    return;
  }
  // Measurement only, for the "tool definitions in context" card: how many tool schemas this request carries and how many stay deferred.
  const tools = parsed ? FORMATS[route.format].toolStats?.(parsed) ?? null : null;

  const { sent, distill } = CONFIG.LLM_GATE_DISTILL
    ? await distilBody({ route, parsed, body })
    : { sent: body, distill: null };
  const outcome = await forwardRequest({ req, res, body: sent, route });
  log.info('llm-gate', `${req.method} ${path} -> ${route.format} ${outcome.status}`, {
    ms: outcome.durationMs,
    ...(sent === body ? {} : { distilled: `${body.length}->${sent.length}` }),
    ...(outcome.clientAborted ? { client_aborted: true } : {}),
  });
  // Conversation memory: note this turn now that the response is complete; the fold itself runs later, only
  // when this process has no request in flight (src/llm-gate/memory.ts).
  const memory = parsed && route.generation ? noteMemory({ route, parsed }) : null;
  if (route.generation) recordRequest({ reqId, path, body, parsed, route, outcome, sent, distill, tools, memory });
}

/** What the ledger row says about the conversation's memory: numbers only, never the text. */
interface MemoryNote {
  turns_known: number;
  age_s: number | null;
}

function noteMemory(params: { route: UpstreamRoute; parsed: JsonObject }): MemoryNote | null {
  if (!CONFIG.CONVERSATION_MEMORY) return null;
  const format = FORMATS[params.route.format];
  if (!format.historyEntries) return null;
  try {
    const key = conversationKey(params.parsed);
    const entries = format.historyEntries(params.parsed);
    const root = format.workspaceOf?.(params.parsed) ?? null;
    noteTurn({ key, root, discriminator: conversationDiscriminator(params.parsed), entries });
    const row = readMemoryRow(key);
    return { turns_known: row?.turns ?? 0, age_s: row ? Math.round((Date.now() - new Date(row.folded_at).getTime()) / 1000) : null };
  } catch (err) {
    log.warn('memory', 'turn not noted', { error: err });
    return null;
  }
}

/**
 * Handles every request to the `llm-gate`.
 *
 * Only programs on this computer are served (src/utils/local-only.ts); anything else gets a 403 and is
 * neither forwarded nor recorded. Every supported request is forwarded, unchanged and with the tool's own
 * login, to the provider its wire format belongs to (see forward.ts), and the response is streamed back
 * unchanged. Answers CORS preflights itself so web pages served from this computer can reach it.
 */
export function requestListener(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!isLocalRequest(req.headers)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'slm_gate_error', message: 'slm-gate only accepts requests from programs on this computer' } }));
    return;
  }

  const reqId = generateId();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  let received = 0;
  let refused = false;
  req.on('data', (chunk: Buffer) => {
    if (refused) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      refused = true;
      chunks.length = 0;
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      // The rest of the upload is dropped once the answer has reached the client.
      res.once('finish', () => req.destroy());
      res.end(JSON.stringify({ error: { type: 'slm_gate_body_too_large', message: `slm-gate reads request bodies up to ${MAX_BODY_BYTES} bytes` } }));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (refused) return;
    handleRequest({ req, res, reqId, body: Buffer.concat(chunks) }).catch(err => {
      // Only a ledger or programming error reaches here; the response may already be complete.
      log.error('llm-gate', 'request failed', { id: reqId, error: err });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'slm_gate_error', message: err instanceof Error ? err.message : String(err) } }));
      }
    });
  });
  // The client dropped while still sending (or was cut off above): nothing was forwarded, nothing to record.
  req.on('error', () => { if (!refused) res.destroy(); });
}

/** A server for tests; the gate itself listens through listenOnThisComputer (index.ts). */
export const server = http.createServer(requestListener);
