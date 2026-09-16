import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from '../src/config.js';
import { LedgerEvent, writeEvent } from '../src/ledger/index.js';

/**
 * Langfuse environment tag for benchmark traffic. Keeps harness runs out of the real-traffic
 * view — without it, bench events land in the same ledger and the same dashboard as
 * production events and silently skew every widget.
 */
const BENCH_ENVIRONMENT = 'bench';
import { deriveArms, GradedResult } from './arms.js';
import { renderSvg } from './curve.js';
import { loadTasks } from './dataset.js';
import { extractAnswer, gradeAnswer } from './grade.js';
import { writeReport } from './report.js';
import { processPipeline, waitWithBackoff } from '../src/llm-gate/pipeline.js';
import { InternalRequest } from '../src/llm-gate/formats/internal.js';

const CACHE_DIR = path.join(CONFIG.ROOT_DIR, 'harness', '.cache');
const OUTPUT_DIR = CONFIG.OUTPUT_DIR;

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Represents a cached evaluation result.
 * Stores configuration state alongside the result to ensure 
 * changes to models or prompts automatically invalidate stale answers.
 */
interface CacheEntry {
  promptVersion: string;
  slmModel: string;
  apiModel: string;
  taskId: string;
  route: string; // 'force-local' | 'raw' | 'auto'
  answer: string;
  inTokens: number;
  outTokens: number;
  cost: number;
  ts: string;
  error?: string;
  armBRoute?: LedgerEvent['route'];
}

function getCachePath(taskId: string, route: string) {
  return path.join(CACHE_DIR, `synthetic_${taskId}_${route}.json`);
}

/**
 * Reads an evaluation result from the cache.
 * Returns null (forcing a re-fetch) if the cache entry was generated 
 * using a different prompt version, SLM model, or Cloud model than 
 * currently configured.
 */
function readCache(taskId: string, route: string): CacheEntry | null {
  const p = getCachePath(taskId, route);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as CacheEntry;
    if (
      data.promptVersion === CONFIG.PROMPT_VERSION &&
      data.slmModel === CONFIG.SLM_GATE_TESTING_MODEL &&
      data.apiModel === (CONFIG.CLOUD_MODEL || 'unknown')
    ) {
      return data;
    } else {
      console.log(`cache stale (model changed): re-fetching ${taskId} ${route}`);
      return null;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function writeCache(taskId: string, route: string, entry: CacheEntry) {
  const p = getCachePath(taskId, route);
  fs.writeFileSync(p, JSON.stringify(entry, null, 2));
}

/**
 * Executes a simulated request through the LLM gate's internal pipeline.
 * Bypasses HTTP boundaries entirely to avoid networking flakiness and 
 * the requirement to have the `llm-gate` server running during benchmark execution.
 */
async function callLlmGate(prompt: string, routeHeader: string, taskId?: string): Promise<{ answer: string, reqId: string | null, error?: string, cost?: number, inTokens?: number, outTokens?: number, route?: LedgerEvent['route'] }> {
  try {
    const req: InternalRequest = {
      model: CONFIG.CLOUD_MODEL || 'unknown',
      messages: [{ role: 'user', content: prompt }]
    };
    const reqId = crypto.randomUUID();
    const res = await processPipeline(reqId, req, { 
      routePolicy: routeHeader as any,
      localModel: CONFIG.SLM_GATE_TESTING_MODEL
    });

    const event: LedgerEvent = {
      ts: new Date().toISOString(),
      layer: 'llm',
      request_id: reqId,
      route: res.route,
      is_local_call: res.isLocal ? 1 : 0,
      slm_model: res.isLocal ? res.model : undefined,
      api_model: res.isLocal ? undefined : res.model,
      in_tok: res.isLocal ? res.inTok : 0,
      out_tok: res.isLocal ? res.outTok : 0,
      api_in_tok: res.apiInTok,
      api_out_tok: res.apiOutTok,
      cost_usd: res.costUsd,
      slm_latency_s: res.slmLatency,
      api_latency_s: res.apiLatency,
      verifier_flags: JSON.stringify(res.verifierFlags),
      slm_gate: routeHeader === 'raw' ? 'off' : 'on',
      meta: JSON.stringify({ 
        raw_in_tok: res.inTok, 
        taskId,
        category: res.category,
        local_attempted: res.localAttempted ? 1 : 0,
        local_accepted: res.localAccepted ? 1 : 0,
        prompt_chars: res.promptChars,
        prompt_tok_est: res.promptTokEst,
        has_code_fence: res.hasCodeFence ? 1 : 0
      })
    };
    writeEvent({ ...event, environment: BENCH_ENVIRONMENT });
    
    return {
      answer: extractAnswer(res.body),
      reqId,
      cost: res.costUsd,
      inTokens: res.inTok,
      outTokens: res.outTok,
      route: res.route
    };
  } catch (err: any) {
    return { answer: '', reqId: null, error: err.message };
  }
}

async function callLlmGateWithRetry(prompt: string, routeHeader: string, taskId?: string) {
  let res = await callLlmGate(prompt, routeHeader, taskId);
  let retries = 2;
  while (res.error && retries > 0 && (res.error.includes('Too Many Requests') || res.error.includes('fetch failed'))) {
    await waitWithBackoff(2 - retries, 2, `[harness] Transient error on ${taskId || 'task'} (${routeHeader}): ${res.error}`);
    res = await callLlmGate(prompt, routeHeader, taskId);
    retries--;
  }
  return res;
}

/**
 * Main execution harness.
 * Processes each task through up to three configured routes:
 * 1. force-local: Used to calculate the all-SLM baseline.
 * 2. raw: Used to calculate the 100%-Cloud (Arm A) baseline.
 * 3. auto: The actual intelligent routing mechanism (Arm B).
 */
async function run() {
  const args = process.argv.slice(2);
  const nArgIdx = args.indexOf('--n');
  let numTasks = -1;
  if (nArgIdx >= 0 && args[nArgIdx + 1]) {
    numTasks = parseInt(args[nArgIdx + 1], 10);
  }

  const hasCloud = !!CONFIG.CLOUD_API_KEY && !!CONFIG.CLOUD_MODEL;
  if (!hasCloud) {
    console.log('WARNING: CLOUD_* is unset. Gracefully degrading to all_slm only.');
  }

  const tasks = loadTasks();
  const tasksToRun = numTasks > 0 ? tasks.slice(0, numTasks) : tasks;
  const results: GradedResult[] = [];
  let errorCount = 0;

  const BATCH_SIZE = 3;
  let completed = 0;
  console.log(`Starting benchmark for ${tasksToRun.length} tasks (Model: ${CONFIG.SLM_GATE_TESTING_MODEL}, Concurrency: ${BATCH_SIZE})...`);

  for (let i = 0; i < tasksToRun.length; i += BATCH_SIZE) {
    const batch = tasksToRun.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (task) => {
      // 1. Calculate All-SLM Baseline (force-local)
      let localCache = readCache(task.id, 'force-local');
      if (!localCache) {
        const { answer, error } = await callLlmGateWithRetry(task.prompt, 'force-local', task.id);
        localCache = {
          promptVersion: CONFIG.PROMPT_VERSION,
          slmModel: CONFIG.SLM_GATE_TESTING_MODEL,
          apiModel: CONFIG.CLOUD_MODEL || 'unknown',
          taskId: task.id,
          route: 'force-local',
          answer,
          inTokens: 0,
          outTokens: 0,
          cost: 0,
          ts: new Date().toISOString(),
          error
        };
        writeCache(task.id, 'force-local', localCache);
      }
      const slmCorrect = gradeAnswer(task, localCache.answer) && !localCache.error;
      if (localCache.error) errorCount++;

      let apiCorrect = false;
      let apiCost = 0;
      let apiInTokens = 0;
      let apiOutTokens = 0;
      
      let armBCorrect = false;
      let armBRoute: LedgerEvent['route'] = 'forward_raw';
      let armBCost = 0;
      let armBInTokens = 0;
      let armBOutTokens = 0;

      if (hasCloud) {
        // 2. Calculate All-Cloud Baseline (Arm A)
        let rawCache = readCache(task.id, 'raw');
        if (!rawCache) {
          const { answer, reqId, error, cost, inTokens, outTokens } = await callLlmGateWithRetry(task.prompt, 'raw', task.id);
          rawCache = {
            promptVersion: CONFIG.PROMPT_VERSION,
            slmModel: CONFIG.SLM_GATE_TESTING_MODEL,
            apiModel: CONFIG.CLOUD_MODEL || 'unknown',
            taskId: task.id,
            route: 'raw',
            answer,
            inTokens: inTokens || 0,
            outTokens: outTokens || 0,
            cost: cost || 0,
            ts: new Date().toISOString(),
            error
          };
          writeCache(task.id, 'raw', rawCache);
        }
        apiCorrect = gradeAnswer(task, rawCache.answer) && !rawCache.error;
        apiCost = rawCache.cost;
        apiInTokens = rawCache.inTokens || 0;
        apiOutTokens = rawCache.outTokens || 0;
        if (rawCache.error) errorCount++;

        // 3. Evaluate the Router logic (Arm B)
        let autoCache = readCache(task.id, 'auto');
        if (!autoCache) {
          const { answer, reqId, error, cost, inTokens, outTokens, route } = await callLlmGateWithRetry(task.prompt, 'auto', task.id);
          autoCache = {
            promptVersion: CONFIG.PROMPT_VERSION,
            slmModel: CONFIG.SLM_GATE_TESTING_MODEL,
            apiModel: CONFIG.CLOUD_MODEL || 'unknown',
            taskId: task.id,
            route: 'auto',
            answer,
            inTokens: inTokens || 0,
            outTokens: outTokens || 0,
            cost: cost || 0,
            ts: new Date().toISOString(),
            error,
            armBRoute: route || 'forward_raw'
          };
          writeCache(task.id, 'auto', autoCache);
        }
        armBCorrect = gradeAnswer(task, autoCache.answer) && !autoCache.error;
        armBCost = autoCache.cost;
        armBInTokens = autoCache.inTokens || 0;
        armBOutTokens = autoCache.outTokens || 0;
        armBRoute = autoCache.armBRoute || 'forward_raw';
        if (autoCache.error) errorCount++;

        // Record the event into SQLite ledger
        const isLocal = armBRoute === 'defer_local';
        const event: LedgerEvent = {
          ts: autoCache.ts || new Date().toISOString(),
          layer: 'llm',
          request_id: `bench_${task.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          route: armBRoute,
          is_local_call: isLocal ? 1 : 0,
          slm_model: isLocal ? autoCache.slmModel : undefined,
          api_model: !isLocal ? autoCache.apiModel : undefined,
          in_tok: isLocal ? armBInTokens : 0,
          out_tok: isLocal ? armBOutTokens : 0,
          api_in_tok: !isLocal ? armBInTokens : 0,
          api_out_tok: !isLocal ? armBOutTokens : 0,
          cost_usd: armBCost,
          slm_latency_s: 0.15,
          api_latency_s: 0.45,
          quality_score: armBCorrect ? 1.0 : 0.0,
          slm_gate: 'on',
          meta: JSON.stringify({ 
            taskId: task.id, 
            synthetic: true, 
            raw_in_tok: armBInTokens,
            category: task.category,
            local_attempted: isLocal ? 1 : 0,
            local_accepted: isLocal ? 1 : 0
          })
        };
        writeEvent({ ...event, environment: BENCH_ENVIRONMENT });
      }

      results.push({
        taskId: task.id,
        route: armBRoute,
        slmCorrect,
        apiCorrect,
        armBCorrect,
        armBRoute,
        armBCost,
        apiCost,
        armBInTokens,
        armBOutTokens,
        apiInTokens,
        apiOutTokens
      });
      
      completed++;
    }));
    
    console.log(`[${completed}/${tasksToRun.length}] Processed tasks...`);
  }

  const arms = deriveArms(results);
  writeReport(path.join(OUTPUT_DIR, 'leaderboard.md'), arms, hasCloud, tasksToRun.length, errorCount);

  if (hasCloud) {
    const svgStr = renderSvg(arms.allSlm, arms.armA, arms.armB, arms.randomAtF, arms.oracleAtF);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'deferral_curve.svg'), svgStr);
    console.log('Wrote output/deferral_curve.svg');
  }
  
  console.log('Wrote output/leaderboard.md');
  if (errorCount > 0) {
    console.log(`NOTE: ${errorCount} tasks encountered errors (timeouts/crashes) and were graded as incorrect.`);
  }
}

if (process.env.NODE_ENV !== 'test') {
  run().catch(err => {
    console.error('Harness run failed:', err);
    process.exit(1);
  });
}

export { CacheEntry, getCachePath, readCache, writeCache };
