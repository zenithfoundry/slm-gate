import { checkSemanticCache, setSemanticCache } from '../cache/index.js';
import { CONFIG } from '../config.js';
import { LedgerEvent, getDb } from '../ledger/index.js';
import { handleSlmError } from '../models/helpers.js';
import { classify } from '../models/reasoning.js';
import { SLM } from '../models/slm.js';
import { calculateCostUsd } from '../pricing/index.js';
import { waitWithBackoff as sharedWaitWithBackoff } from '../utils/backoff.js';
import { compressContext } from '../utils/compression.js';
import { isLatestInstructionFromTool } from '../utils/safety.js';
import { verify } from '../verifier/index.js';
import { buildAnthropicRequest } from './formats/anthropic.js';
import { InternalMessage, InternalRequest } from './formats/internal.js';
import { buildOpenAIRequest } from './formats/openai.js';

export interface PipelineOptions {
  routePolicy: 'raw' | 'auto' | 'force-local';
  localModel?: string;
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

function getCategorySuccessRate(category: string, window: number, minSamples: number): number | null {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT json_extract(meta, '$.local_accepted') as accepted
      FROM events
      WHERE layer = 'llm'
        AND json_extract(meta, '$.category') = ?
        AND json_extract(meta, '$.local_attempted') = 1
      ORDER BY ts DESC
      LIMIT ?
    `).all(category, window) as { accepted: 1 | 0 | null | boolean }[];

    if (rows.length < minSamples) {
      return null;
    }

    let acceptedCount = 0;
    for (const row of rows) {
      if (row.accepted === 1 || row.accepted === true) {
        acceptedCount++;
      }
    }
    return acceptedCount / rows.length;
  } catch (e) {
    return null; // fail open on error
  }
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
  const slm = new SLM();
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

  // SEMANTIC CACHE check
  let cachedResponse = null;
  if (isSafeForLocal && CONFIG.SEMCACHE) {
    // Only cache if it's read-only. We check this with the heuristics or classification later, 
    // but a quick check is if it's safe for local (no tools)
    cachedResponse = await checkSemanticCache(normalizedText);
    if (cachedResponse) {
      result.route = 'defer_local'; // or 'cache_hit' if we map it, but defer_local gets correct logging
      result.isLocal = true;
      result.model = 'semcache';
      result.outTok = estimateTokens(cachedResponse);
      result.costUsd = 0; // The actual cost is $0
      
      // add a flag so we can see it in ledger
      if (!result.verifierFlags) result.verifierFlags = [];
      result.verifierFlags.push('cache_hit');

      result.body = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: cachedResponse
            }
          }
        ]
      };
      return result;
    }
  }

  if (routePolicy === 'force-local' || (routePolicy === 'auto' && isSafeForLocal)) {
    // Attempt local classification
    let category = 'other';
    try {
      if (taskText) {
        category = await classify(slm, taskText);
      }
    } catch (e) {
      // Classification failed, default to 'other'
    }

    result.category = category;

    // The `baseAllowList` defines which task categories the SLM is allowed to attempt answering locally.
    // Small Language Models excel at deterministic, narrow, and structurally simple tasks but struggle with complex reasoning.
    // Note: This list perfectly mirrors the ENUM output schema defined in `src/models/reasoning.ts` (excluding 'other').
    // To expand this list with new capabilities (e.g. 'query_rewrite', 'guardrail_check'), we must also update the classify() prompt schema!
    const baseAllowList = ['classify', 'extract', 'format', 'boolean', 'short_factual', 'trivial_edit'];
    let isEligible = baseAllowList.includes(category);
    
    if (CONFIG.ROUTING_TUNE && isEligible && routePolicy !== 'force-local') {
      if (Math.random() < CONFIG.ROUTING_TUNE_EXPLORE_RATE) {
        isEligible = true; // Epsilon-greedy exploration
      } else {
        const rate = getCategorySuccessRate(category, CONFIG.ROUTING_TUNE_WINDOW, CONFIG.ROUTING_TUNE_MIN_SAMPLES);
        if (rate !== null && rate < CONFIG.ROUTING_TUNE_THRESHOLD) {
          isEligible = false;
        }
      }
    }

    if (routePolicy === 'force-local' || isEligible) {
      result.localAttempted = true;
      // Try local answer
      try {
        let answer = '';
        let samples: string[] = [];
        
        if (CONFIG.HEADLINE_STRICTNESS >= 4) {
          // Just run it 3 times sequentially to simulate generating samples
          // A proper selfConsistency requires structured outputs, but for text we can do it here:
          const k = CONFIG.SELF_CONSISTENCY_K;
          const promises = Array.from({ length: k }).map(() =>
            slm.generateText(localModel, messages, CONFIG.SELF_CONSISTENCY_TEMP)
          );
          samples = await Promise.all(promises);
          answer = samples[0]; // Simplified: just pick first or we could use checkAgreement if we lifted it
        } else {
          answer = await slm.generateText(localModel, messages, CONFIG.TEMPERATURE);
        }

        const vResult = verify(answer, samples, { nonEmpty: true }, CONFIG.HEADLINE_STRICTNESS);
        result.verifierFlags = vResult.flags;
        
        // Note: localAccepted means the VERIFIER accepted the answer (non-empty, no hedging, samples agree) 
        // — a PROXY for quality, not ground-truth correctness.
        result.localAccepted = !vResult.escalate;

        if (!vResult.escalate || routePolicy === 'force-local') {
          localDeferred = true;
          localAnswer = answer;
        }
      } catch (e: any) {
        if (e.name === 'SlmTimeoutError' || e.message?.includes('fetch failed') || e.code === 'ECONNREFUSED' || e.message?.includes('ECONNREFUSED')) {
          handleSlmError(e, 'llm-gate:generate', localModel);
        } else {
          handleSlmError(e, 'llm-gate:generate', localModel);
        }
        // Local generation failed, fall through to escalate
      }
    }
  }

  result.slmLatency = (Date.now() - t0) / 1000;

  if (localDeferred) {
    result.route = 'defer_local';
    result.isLocal = true;
    result.model = localModel;
    result.outTok = estimateTokens(localAnswer);
    result.costUsd = calculateCostUsd(localModel, result.inTok, result.outTok);

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

  // --- BEGIN INJECTION: SLM Gate & Architecture Context ---
  let slmGateNotice = `\n\n[ARCHITECTURE CONTEXT: You are operating as the cloud-tier engine behind the Small Language Model (SLM) Gate. `;
  
  if (routePolicy !== 'raw') {
     slmGateNotice += `Your prompt context has already been intercepted, reviewed, and potentially restructured or compressed by local SLM models. Some parts of the original request may have already been handled locally. Focus strictly on fulfilling the remaining objectives presented in your context. `;
  } else {
     slmGateNotice += `The SLM Gate has forwarded this request to you in a raw state. `;
  }

  slmGateNotice += `You MUST acknowledge your position behind the SLM Gate in your initial thinking.]`;

  if (CONFIG.TLS_ADAPTER) {
    slmGateNotice += `\n[TECH LEAD STACK (TLS): You have access to the TLS MCP. The SLM Gate may have already loaded certain workflows or skills into your context. Review your current context thoroughly. If a loaded workflow explicitly instructs you to fetch a specific skill via the TLS MCP, you MUST fetch it, UNLESS you can see the full text of that specific skill already present in your prompt. Do not redundantly fetch skills that are already loaded, but do not ignore explicit workflow instructions to fetch missing skills.]`;
  }

  compressedReq.system = (compressedReq.system || '') + slmGateNotice;
  // --- END INJECTION ---

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
