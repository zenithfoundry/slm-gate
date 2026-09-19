import http from 'node:http';
import { CONFIG } from '../config.js';
import { writeEvent } from '../ledger/index.js';
import { estimateTokens } from '../utils/elision.js';
import { DistillStats, distilRequest } from './distill.js';
import * as anthropic from './formats/anthropic.js';
import * as chatCompletions from './formats/chat-completions.js';
import { WireFormatModule } from './formats/contract.js';
import * as gemini from './formats/gemini.js';
import * as responses from './formats/responses.js';
import { ForwardOutcome, forwardRequest, resolveUpstream, SUPPORTED_PATHS, UpstreamRoute, WireFormat } from './forward.js';

const FORMATS: Record<WireFormat, WireFormatModule> = {
  anthropic,
  'chat-completions': chatCompletions,
  responses,
  gemini,
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

/**
 * Step B: the bytes to forward. The original bytes go out whenever nothing changed, the body is not
 * JSON, or distillation fails in any way — it can make a request smaller, never break it.
 */
async function distilBody(params: { route: UpstreamRoute; body: Buffer }): Promise<{ sent: Buffer; distill: DistillStats | null }> {
  const { route, body } = params;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { sent: body, distill: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { sent: body, distill: null };
  try {
    const result = await distilRequest({ format: FORMATS[route.format], body: parsed as Record<string, unknown> });
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
}): void {
  const { reqId, path } = params;
  try {
    writeLedgerRow(params);
  } catch (err) {
    // Telemetry must never hold up model traffic: the row is lost, the request is not.
    console.error(`LLM Gate: ledger row for ${reqId} (${path}) not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeLedgerRow(params: Parameters<typeof recordRequest>[0]): void {
  const { reqId, path, body, route, outcome, distill = null } = params;
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
    slm_latency_s: 0,
    api_latency_s: (outcome.durationMs ?? 0) / 1000,
    slm_gate: 'on',
    meta: JSON.stringify({
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

  const { sent, distill } = route.generation && CONFIG.LLM_GATE_DISTILL
    ? await distilBody({ route, body })
    : { sent: body, distill: null };
  const outcome = await forwardRequest({ req, res, body: sent, route });
  const saved = sent === body ? '' : `, distilled ${body.length} -> ${sent.length} bytes`;
  console.info(`LLM Gate: ${req.method} ${path} -> ${route.format} ${outcome.status} in ${outcome.durationMs}ms${saved}${outcome.clientAborted ? ' (client aborted)' : ''}`);
  if (route.generation) recordRequest({ reqId, path, body, route, outcome, sent, distill });
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
