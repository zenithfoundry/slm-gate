import { setSemanticCache } from '../cache/index.js';
import { CONFIG } from '../config.js';
import { LedgerEvent } from '../ledger/index.js';
import { calculateCostUsd } from '../pricing/index.js';
import { waitWithBackoff as sharedWaitWithBackoff } from '../utils/backoff.js';
import { compressContext } from '../utils/compression.js';
import { isLatestInstructionFromTool } from '../utils/safety.js';
import { buildAnthropicRequest } from './formats/anthropic.js';
import { InternalMessage, InternalRequest } from './formats/internal.js';
import { buildOpenAIRequest } from './formats/openai.js';
import { attemptLocalAnswer } from './local-first.js';

export interface PipelineOptions {
  routePolicy: 'raw' | 'auto' | 'force-local';
  localModel?: string;
  /** Ledger environment ROUTING_TUNE learns from (the harness passes its 'bench' tag). */
  environment?: string;
}

export interface PipelineResult {
  body: any;
  route: LedgerEvent['route'];
  isLocal: boolean;
  model: string;
  inTok: number;
  outTok: number;
  apiInTok: number;
  apiOutTok: number;
  costUsd: number;
  slmLatency: number;
  apiLatency: number;
  verifierFlags: string[];
  category?: string;
  localAttempted?: boolean;
  localAccepted?: boolean;
  promptChars?: number;
  promptTokEst?: number;
  hasCodeFence?: boolean;
}

/**
 * Determines whether an unknown thrown value is a transient, retryable network failure.
 *
 * @desc Inspects error name, system error code, and message signatures for network aborts/timeouts.
 * @param err The caught unknown exception
 * @returns True if the error is considered transient and safe to retry
 * @example
 * ```ts
 * if (isRetryableNetworkError(err) && attempt < MAX_RETRIES) { ... }
 * ```
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    return err.name === 'TimeoutError' || code === 'ECONNRESET' || err.message.includes('fetch failed');
  }
  return false;
}

/**
 * Calculates exponential backoff with jitter and awaits the delay period.
 *
 * @desc Computes 1500ms * 2^attempt + jitter, respecting an optional `Retry-After` header value in seconds.
 * Logs a diagnostic warning to stderr before waiting.
 * @param attempt Current zero-indexed retry attempt
 * @param maxRetries Total allowed retry attempts
 * @param reason Human-readable context for why the backoff is being executed
 * @param retryAfter Optional `Retry-After` header string from HTTP response
 * @returns Promise that resolves once the backoff delay has completed
 * @example
 * ```ts
 * await waitWithBackoff(attempt, MAX_RETRIES, 'Upstream HTTP 429', res.headers.get('retry-after'));
 * ```
 */
export async function waitWithBackoff(
  attempt: number,
  maxRetries: number,
  reason: string,
  retryAfter?: string | null
): Promise<void> {
  // Implementation lives in utils/backoff.ts so the ledger's Langfuse flush can share it
  // without a circular import. This wrapper preserves the existing call signature.
  return sharedWaitWithBackoff(attempt, maxRetries, reason, retryAfter, 'llm-gate');
}

// Very basic token estimator. A real implementation would use a proper tokenizer like tiktoken.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function countMessagesTokens(messages: InternalMessage[], system?: string): number {
  let text = system || '';
  for (const m of messages) {
    text += '\n' + m.content;
  }
  return estimateTokens(text);
}

/**
 * The core orchestration pipeline for a single LLM Gate request.
 * 
 * Pipeline flow:
 * 1. Derives the core task from the last user message.
 * 2. If routePolicy allows local deferral and heuristics approve (no tool injection), 
 *    classifies the task with the SLM.
 * 3. If the task type is simple enough, generates an answer locally.
 * 4. Verifies the local answer against rigorous constraints.
 * 5. If verified and safe, returns the local answer (deferring the cloud call entirely).
 * 6. If it escalates or is forced, compresses the context and calls the upstream Cloud API.
 * 
 * @param reqId A unique request identifier
 * @param internalReq The internal request representation
 * @param options Routing configurations
 * @returns A fully constructed response payload and detailed token/cost analytics
 */
export async function processPipeline(
  reqId: string,
  internalReq: InternalRequest,
  options: PipelineOptions
): Promise<PipelineResult> {
  console.info('LLM Gate Pipeline: Started');

  const t0 = Date.now();
  const messages = internalReq.messages;

  const result: PipelineResult = {
    body: null,
    route: 'forward_raw',
    isLocal: false,
    model: '',
    inTok: countMessagesTokens(messages, internalReq.system),
    outTok: 0,
    apiInTok: 0,
    apiOutTok: 0,
    costUsd: 0,
    slmLatency: 0,
    apiLatency: 0,
    verifierFlags: [],
    category: undefined,
    localAttempted: false,
    localAccepted: false,
    promptChars: 0,
    promptTokEst: 0,
    hasCodeFence: false
  };

  const isSafeForLocal = !isLatestInstructionFromTool(messages);
  const routePolicy = options.routePolicy;

  let localDeferred = false;
  let localAnswer = '';
  let localModel = options.localModel || CONFIG.SLM_BRAIN_MODEL;

  // Derive task (last user message)
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  let taskText = lastUserMsg ? lastUserMsg.content : '';
  
  // Normalize by stripping simple timestamps/ids from text if needed, but for now we'll just use taskText
  const normalizedText = taskText;

  result.promptChars = taskText.length;
  result.promptTokEst = estimateTokens(taskText);
  result.hasCodeFence = /```/.test(taskText);

  // Local answer: the same implementation the model gate uses (local-first.ts), so the bench measures
  // what ships. It includes the semantic cache, which is therefore only consulted on this path now.
  let fromCache = false;
  if (routePolicy === 'force-local' || (routePolicy === 'auto' && isSafeForLocal)) {
    const attempt = await attemptLocalAnswer({
      task: taskText,
      messages,
      toolsListed: (internalReq.tools?.length ?? 0) > 0,
      routePolicy,
      localModel,
      environment: options.environment,
    });
    result.category = attempt.category;
    result.localAttempted = attempt.attempted;
    result.localAccepted = attempt.accepted;
    result.verifierFlags = attempt.verifierFlags;
    if (attempt.answer !== null) {
      localDeferred = true;
      localAnswer = attempt.answer;
      localModel = attempt.model;
      fromCache = attempt.fromCache;
    }
  }

  result.slmLatency = (Date.now() - t0) / 1000;

  if (localDeferred) {
    result.route = 'defer_local';
    result.isLocal = true;
    result.model = localModel;
    result.outTok = estimateTokens(localAnswer);
    result.costUsd = fromCache ? 0 : calculateCostUsd(localModel, result.inTok, result.outTok);

    // Format local answer as a standard completion in the internal format
    // Since we stream in the server based on the return format, here we just return the full response.
    // Streaming wrapper is handled outside if internalReq.stream is true.
    result.body = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: localAnswer
          }
        }
      ]
    };
    return result;
  }

  // Fallthrough: Escalate to Cloud
  const t1 = Date.now();
  let compressedReq = { ...internalReq };
  
  if (routePolicy !== 'raw') {
    compressedReq.messages = await compressContext(messages);
    result.route = 'forward_compressed';
  } else {
    result.route = 'forward_raw';
  }

  // The system prompt goes out as the client sent it: the gate adds nothing to the model's instructions
  // and names no toolbox (toolboxes are plug-and-play behind the MCP layer).

  // Format the request for the cloud provider
  let fetchUrl = CONFIG.CLOUD_BASE_URL;
  let fetchHeaders: any = {
    'Content-Type': 'application/json'
  };
  let fetchBody: any;

  if (CONFIG.CLOUD_API_STYLE === 'anthropic') {
    if (fetchUrl && !fetchUrl.endsWith('/messages')) {
      fetchUrl = fetchUrl.replace(/\/+$/, '') + '/messages';
    } else if (!fetchUrl) {
      fetchUrl = 'https://api.anthropic.com/v1/messages';
    }
    fetchHeaders['x-api-key'] = CONFIG.CLOUD_API_KEY;
    fetchHeaders['anthropic-version'] = '2023-06-01';
    fetchBody = buildAnthropicRequest(compressedReq);
  } else {
    // openai style
    if (fetchUrl && !fetchUrl.endsWith('/chat/completions')) {
      fetchUrl = fetchUrl.replace(/\/+$/, '') + '/chat/completions';
    } else if (!fetchUrl) {
      fetchUrl = 'https://api.openai.com/v1/chat/completions';
    }
    fetchHeaders['Authorization'] = `Bearer ${CONFIG.CLOUD_API_KEY}`;
    fetchBody = buildOpenAIRequest(compressedReq);
  }

  result.apiInTok = countMessagesTokens(compressedReq.messages, compressedReq.system);

  // Perform API request with exponential backoff for 429 / 5xx and transient network issues
  const MAX_RETRIES = 3;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const apiRes = await fetch(fetchUrl!, {
        method: 'POST',
        headers: fetchHeaders,
        body: JSON.stringify(fetchBody),
        signal: AbortSignal.timeout(30000)
      });

      if (!apiRes.ok) {
        const isRateLimit = apiRes.status === 429;
        const isServerErr = apiRes.status >= 500 && apiRes.status < 600;

        if ((isRateLimit || isServerErr) && attempt < MAX_RETRIES) {
          await waitWithBackoff(
            attempt,
            MAX_RETRIES,
            `Upstream HTTP ${apiRes.status} (${apiRes.statusText})`,
            apiRes.headers.get('retry-after')
          );
          continue;
        }

        throw new Error(`Cloud API Error: ${apiRes.statusText || apiRes.status}`);
      }

      if (internalReq.stream) {
        // In stream mode, we return the stream to the caller
        result.body = apiRes.body; // Pass the readable stream
      } else {
        const data: unknown = await apiRes.json();
        result.body = data;
        
        // Token counting
        const usage = (data as { usage?: { output_tokens?: number; completion_tokens?: number; input_tokens?: number; prompt_tokens?: number } })?.usage;
        if (CONFIG.CLOUD_API_STYLE === 'anthropic') {
          result.apiOutTok = usage?.output_tokens || 0;
          result.apiInTok = usage?.input_tokens || result.apiInTok;
        } else {
          result.apiOutTok = usage?.completion_tokens || 0;
          result.apiInTok = usage?.prompt_tokens || result.apiInTok;
        }
      }
      lastErr = null;
      break;
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      lastErr = errorObj;

      if (isRetryableNetworkError(err) && attempt < MAX_RETRIES) {
        await waitWithBackoff(
          attempt,
          MAX_RETRIES,
          `Cloud network error (${errorObj.message})`
        );
        continue;
      }
      break;
    }
  }

  if (lastErr) {
    throw new Error(`Cloud request failed: ${lastErr.message}`);
  }

  if (isSafeForLocal && CONFIG.SEMCACHE) {
    let responseText = '';
    if (result.body && result.body.choices && result.body.choices[0] && result.body.choices[0].message) {
      responseText = result.body.choices[0].message.content;
      if (responseText) {
        await setSemanticCache(normalizedText, responseText);
      }
    }
  }

  result.apiLatency = (Date.now() - t1) / 1000;
  result.model = CONFIG.CLOUD_MODEL || 'unknown';
  result.outTok = result.apiOutTok;
  result.costUsd = calculateCostUsd(result.model, result.apiInTok, result.apiOutTok);

  return result;
}
