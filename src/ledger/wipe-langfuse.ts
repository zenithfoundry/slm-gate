/**
 * @fileoverview Deletes slm-gate's own traces from the configured Langfuse project.
 *
 * Other programs may write to the same project, so only traces tagged SLM_GATE_SOURCE_TAG
 * are deleted, and only the score configs the gate registers are archived — never the whole
 * project. Traces written before the tag existed are not matched: `pnpm run ledger:sync`
 * resends them with it.
 *
 * Deleting a trace also deletes its scores and observations (Langfuse's data-deletion docs),
 * so scores are never deleted on their own. The previous script deleted every score first
 * and every trace second; a rate limit between the two passes left the project half wiped.
 *
 * Resumable by construction: each run lists the tagged traces still present, so a run
 * stopped by a quota is continued by running it again after the reset time it prints.
 *
 * Usage:
 *   pnpm run langfuse:wipe [--dry-run]
 */

import { setTimeout } from 'node:timers/promises';
import { CONFIG, requireKeys } from '../config.js';
import { waitWithBackoff } from '../utils/backoff.js';
import { SLM_GATE_SOURCE_TAG } from './index.js';
import { SCORE_CONFIGS } from './sync-config.js';

/** Hobby projects allow 30 requests a minute; one every 2.1 s stays under it. */
const REQUEST_SPACING_MS = 2100;
const MAX_RETRIES = 3;
/** A 429 asking to wait longer than this is a quota (e.g. daily deletes), not a burst: stop and report. */
const MAX_RETRY_WAIT_S = 120;
const DELETE_CHUNK = 100;

interface Page<T> {
  data: T[];
  meta?: { totalPages?: number };
}

/** Seconds a 429/5xx asks us to wait, from the Retry-After header or Langfuse's error body. */
async function retryAfterSeconds(res: Response): Promise<number | null> {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header;
  const body = await res.clone().json().catch(() => null) as { details?: { retryAfterSeconds?: number } } | null;
  return typeof body?.details?.retryAfterSeconds === 'number' ? body.details.retryAfterSeconds : null;
}

/** One paced request, retried on 429 and 5xx unless the wait asked for is a quota reset. */
async function send(params: { path: string; init?: RequestInit; label: string }): Promise<Response> {
  const baseUrl = CONFIG.LANGFUSE_HOST!.replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${CONFIG.LANGFUSE_PUBLIC_KEY}:${CONFIG.LANGFUSE_SECRET_KEY}`).toString('base64')}`;
  for (let attempt = 0; ; attempt++) {
    await setTimeout(REQUEST_SPACING_MS);
    const res = await fetch(`${baseUrl}${params.path}`, {
      ...params.init,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= MAX_RETRIES - 1) return res;
    const wait = await retryAfterSeconds(res);
    if (wait !== null && wait > MAX_RETRY_WAIT_S) return res;
    await waitWithBackoff(attempt, MAX_RETRIES, `${params.label}: HTTP ${res.status}`, wait === null ? null : String(wait), 'wipe');
  }
}

/** Throws with the status and body, so a failed request stops the run instead of being skipped. */
async function failure(res: Response, label: string): Promise<Error> {
  const text = await res.text().catch(() => '');
  if (res.status !== 429) return new Error(`${label} failed (${res.status}): ${text.slice(0, 300)}`);
  let details: { resetAt?: string; retryAfterSeconds?: number; remaining?: number; limit?: number } = {};
  try { details = JSON.parse(text).details ?? {}; } catch { /* not JSON */ }
  const resetAt = details.resetAt ? new Date(details.resetAt).toLocaleString() : 'unknown';
  return new Error(`${label} was rate limited (remaining ${details.remaining ?? '?'} / ${details.limit ?? '?'}). ` +
    `Quota resets at ${resetAt}. Run this command again after that to continue.`);
}

/** Every item of a paginated Langfuse list. */
async function listAll<T>(params: { path: string; label: string }): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const res = await send({ path: `${params.path}${params.path.includes('?') ? '&' : '?'}page=${page}&limit=100`, label: params.label });
    if (!res.ok) throw await failure(res, params.label);
    const body = await res.json() as Page<T>;
    items.push(...(body.data ?? []));
    if ((body.data ?? []).length === 0 || page >= (body.meta?.totalPages ?? 1)) return items;
  }
}

async function wipeLangfuse(options: { dryRun: boolean }): Promise<void> {
  requireKeys(['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST']);

  console.log('=== SLM Gate: delete the gate\'s traces from Langfuse ===\n');
  console.log(`Target host : ${CONFIG.LANGFUSE_HOST}`);
  console.log(`Matching    : traces tagged ${SLM_GATE_SOURCE_TAG}; other writers' traces are left alone`);
  console.log(`Mode        : ${options.dryRun ? 'DRY-RUN (nothing is deleted)' : 'DELETE'}\n`);

  // The trace list is Langfuse's only way to find traces by tag. It is deprecated on Cloud
  // (removal 2026-11-16) and lags live data by about 10 minutes, so traces written in the
  // last few minutes may need a second run.
  const traces = await listAll<{ id: string }>({
    path: `/api/public/traces?tags=${encodeURIComponent(SLM_GATE_SOURCE_TAG)}`,
    label: 'list gate traces',
  });
  const traceIds = traces.map(t => t.id);
  console.log(`Found ${traceIds.length} gate trace(s). Their scores and observations are deleted with them.`);

  const gateConfigNames = new Set(SCORE_CONFIGS.map(c => c.name));
  const configs = (await listAll<{ id: string; name: string; isArchived?: boolean }>({ path: '/api/public/score-configs', label: 'list score configs' }))
    .filter(c => gateConfigNames.has(c.name) && !c.isArchived);
  console.log(`Found ${configs.length} active gate score config(s) to archive.\n`);

  if (options.dryRun) {
    console.log('Dry run: nothing was deleted.');
    return;
  }

  let deleted = 0;
  for (let i = 0; i < traceIds.length; i += DELETE_CHUNK) {
    const chunk = traceIds.slice(i, i + DELETE_CHUNK);
    const res = await send({ path: '/api/public/traces', init: { method: 'DELETE', body: JSON.stringify({ traceIds: chunk }) }, label: 'delete traces' });
    if (!res.ok) {
      console.error(`\nDeleted ${deleted} of ${traceIds.length} trace(s) before stopping.`);
      throw await failure(res, 'delete traces');
    }
    deleted += chunk.length;
    console.log(`  Deleted ${deleted} / ${traceIds.length}`);
  }

  for (const config of configs) {
    const res = await send({ path: `/api/public/score-configs/${config.id}`, init: { method: 'PATCH', body: JSON.stringify({ isArchived: true }) }, label: `archive score config ${config.name}` });
    if (!res.ok) throw await failure(res, `archive score config ${config.name}`);
    console.log(`  Archived score config ${config.name}`);
  }

  console.log(`\n✓ Deleted ${deleted} gate trace(s) and archived ${configs.length} gate score config(s).`);
  console.log('Langfuse can take ~10 minutes to stop listing deleted traces; check with `pnpm run ledger:verify`.');
}

wipeLangfuse({ dryRun: process.argv.includes('--dry-run') }).catch((err) => {
  console.error('\n⛔', err instanceof Error ? err.message : err);
  process.exit(1);
});
