import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';
import { writeEvent } from '../ledger/index.js';
import { estimateTokens } from '../utils/elision.js';
import { DistillStats, distilRequest } from './distill.js';
import * as anthropic from './formats/anthropic.js';
import * as chatCompletions from './formats/chat-completions.js';
import { JsonObject, WireFormatModule } from './formats/contract.js';
import * as gemini from './formats/gemini.js';
import * as responses from './formats/responses.js';
import { ForwardOutcome, forwardRequest, resolveUpstream, SUPPORTED_PATHS, UpstreamRoute, WireFormat } from './forward.js';
import { answerFirstRequestLocally } from './local-first.js';
import { HEALTH_PATH } from '../setup/model-gate.js';
import { requiredModels } from '../setup/local-models.js';

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
};

function generateId(): string {
  return 'req_' + Math.random().toString(36).substring(2, 15);
}

/** The model a request is for: Gemini names it in the path, the other formats in the body. */
function requestModel(route: UpstreamRoute, body: Buffer): string | undefined {
  if (route.pathModel) return route.pathModel;
  try {
    const model = JSON.parse(body.toString('utf8'))?.model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObject(body: Buffer): JsonObject | null {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** How a Step A attempt went, for the ledger row of the request (answered locally or forwarded). */
interface LocalStep {
  reply: { contentType: string; body: string; answer: string; model: string } | null;
  latencyMs: number;
  verifierFlags: string[];
  /** Ledger meta fields; names match the ones the dashboards already read. */
  meta: Record<string, unknown>;
}

/**
 * Step A: a first request the local model answers itself, in the request's own format. Anything else —
 * a later request, structured output, a busy or slow local model, a declined or rejected answer —
 * returns no reply and the request goes on unchanged.
 */
async function localFirst(params: { route: UpstreamRoute; parsed: JsonObject; body: Buffer }): Promise<LocalStep | null> {
  const { route, parsed, body } = params;
  const format = FORMATS[route.format];
  const prompt = format.firstRequestPrompt(parsed);
  // Gemini's JSON-array streaming (no `alt=sse`) is left to the provider.
  if (!prompt || route.geminiStream === 'json-array') return null;
  const stream = route.format === 'gemini' ? route.geminiStream === 'sse' : parsed.stream === true;

  const started = Date.now();
  let local: Awaited<ReturnType<typeof answerFirstRequestLocally>>;
  try {
    local = await answerFirstRequestLocally({ task: prompt.text, toolsListed: prompt.toolsListed });
  } catch (err) {
    // Step A can only make a request cheaper; if it fails in any way the request goes on as normal.
    console.error(`LLM Gate: local answer skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const { attempt, outcome } = local;
  const step: LocalStep = {
    reply: null,
    latencyMs: Date.now() - started,
    verifierFlags: attempt?.verifierFlags ?? [],
    meta: {
      local_outcome: outcome,
      category: attempt?.category ?? null,
      local_attempted: attempt?.attempted ? 1 : 0,
      local_accepted: attempt?.accepted ? 1 : 0,
      from_cache: attempt?.fromCache ? 1 : 0,
      prompt_chars: prompt.text.length,
      prompt_tok_est: estimateTokens(prompt.text),
      has_code_fence: /```/.test(prompt.text) ? 1 : 0,
    },
  };
  if (!attempt || attempt.answer === null) return step;

  const answer = attempt.answer;
  const reply = format.buildLocalReply({
    text: answer,
    stream,
    model: attempt.model,
    usage: { inputTokens: estimateTokens(body.toString('utf8')), outputTokens: estimateTokens(answer) },
  });
  return { ...step, reply: { ...reply, answer, model: attempt.model } };
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
    console.error(`LLM Gate: distillation skipped for this request: ${err instanceof Error ? err.message : String(err)}`);
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
  route: UpstreamRoute | null;
  outcome: Pick<ForwardOutcome, 'status'> & Partial<ForwardOutcome>;
  /** What was forwarded, when Step B changed the body. */
  sent?: Buffer;
  distill?: DistillStats | null;
  /** A Step A attempt that ended without a local reply. */
  local?: LocalStep | null;
}): void {
  recordSafely({ reqId: params.reqId, path: params.path, write: () => writeLedgerRow(params) });
}

function recordSafely(params: { reqId: string; path: string; write: () => void }): void {
  try {
    params.write();
  } catch (err) {
    // Telemetry must never hold up model traffic: the row is lost, the request is not.
    console.error(`LLM Gate: ledger row for ${params.reqId} (${params.path}) not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The ledger row of a first request the local model answered: the whole cloud request was avoided. */
function recordLocalAnswer(params: { reqId: string; path: string; body: Buffer; route: UpstreamRoute; local: LocalStep }): void {
  const { reqId, path, body, route, local } = params;
  recordSafely({
    reqId,
    path,
    write: () => writeEvent({
      ts: new Date().toISOString(),
      layer: 'llm',
      request_id: reqId,
      route: 'defer_local',
      is_local_call: 1,
      slm_model: local.reply!.model,
      // The provider whose request was avoided, for per-provider savings.
      api_model: requestModel(route, body),
      in_tok: estimateTokens(body.toString('utf8')),
      out_tok: estimateTokens(local.reply!.answer),
      api_in_tok: 0,
      api_out_tok: 0,
      cost_usd: 0,
      slm_latency_s: local.latencyMs / 1000,
      api_latency_s: 0,
      verifier_flags: JSON.stringify(local.verifierFlags),
      slm_gate: 'on',
      meta: JSON.stringify({ format: route.format, path, status: 200, ...local.meta }),
    }),
  });
}

function writeLedgerRow(params: Parameters<typeof recordRequest>[0]): void {
  const { reqId, path, body, route, outcome, distill = null, local = null } = params;
  const sent = params.sent ?? body;
  const distilled = sent !== body;
  writeEvent({
    ts: new Date().toISOString(),
    layer: 'llm',
    request_id: reqId,
    route: distilled ? 'forward_compressed' : 'forward_raw',
    is_local_call: 0,
    api_model: route ? requestModel(route, body) : undefined,
    in_tok: 0,
    out_tok: 0,
    // Estimated from the bodies until provider usage is read from responses.
    api_in_tok: route ? estimateTokens(sent.toString('utf8')) : 0,
    api_out_tok: 0,
    cost_usd: 0,
    slm_latency_s: (local?.latencyMs ?? 0) / 1000,
    api_latency_s: (outcome.durationMs ?? 0) / 1000,
    ...(local ? { verifier_flags: JSON.stringify(local.verifierFlags) } : {}),
    slm_gate: 'on',
    meta: JSON.stringify({
      // A Step A attempt that did not answer: ROUTING_TUNE learns from local_attempted/local_accepted.
      ...(local?.meta ?? {}),
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
    console.info(`LLM Gate: ${req.method} ${path} -> 404 (unsupported path)`);
    recordRequest({ reqId, path, body, route, outcome: { status: 404 } });
    return;
  }

  const parsed = route.generation ? parseJsonObject(body) : null;

  const local = parsed && CONFIG.LLM_GATE_LOCAL_FIRST ? await localFirst({ route, parsed, body }) : null;
  if (local?.reply) {
    res.writeHead(200, { 'content-type': local.reply.contentType, 'x-slm-gate-route': 'defer_local' });
    res.end(local.reply.body);
    console.info(`LLM Gate: ${req.method} ${path} -> answered locally by ${local.reply.model} in ${local.latencyMs}ms`);
    recordLocalAnswer({ reqId, path, body, route, local });
    return;
  }

  const { sent, distill } = CONFIG.LLM_GATE_DISTILL
    ? await distilBody({ route, parsed, body })
    : { sent: body, distill: null };
  const outcome = await forwardRequest({ req, res, body: sent, route });
  const saved = sent === body ? '' : `, distilled ${body.length} -> ${sent.length} bytes`;
  console.info(`LLM Gate: ${req.method} ${path} -> ${route.format} ${outcome.status} in ${outcome.durationMs}ms${saved}${outcome.clientAborted ? ' (client aborted)' : ''}`);
  if (route.generation) recordRequest({ reqId, path, body, route, outcome, sent, distill, local });
}

/**
 * Native HTTP server for the `llm-gate`.
 *
 * Every supported request is forwarded, unchanged and with the tool's own login, to the provider its
 * wire format belongs to (see forward.ts), and the response is streamed back unchanged. Answers CORS
 * preflights itself so web-based clients can reach it.
 */
export const server = http.createServer((req, res) => {
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
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    handleRequest({ req, res, reqId, body: Buffer.concat(chunks) }).catch(err => {
      // Only a ledger or programming error reaches here; the response may already be complete.
      console.error('LLM Gate Error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'slm_gate_error', message: err instanceof Error ? err.message : String(err) } }));
      }
    });
  });
  // The client dropped while still sending: nothing was forwarded, so there is nothing to record.
  req.on('error', () => res.destroy());
});
