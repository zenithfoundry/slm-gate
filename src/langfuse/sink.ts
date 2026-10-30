/**
 * The Langfuse mirror: every event is queued in SQLite at write time (mirrorEvent) and shipped later by
 * flushQueue, which both gates share: rows are claimed atomically, retried with backoff, and parked in
 * langfuse_dead_letter after repeated per-item rejections so one bad row never blocks the queue.
 */
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { log } from '../log.js';
import { LANGFUSE_REQUEST_TIMEOUT_MS, waitWithBackoff } from '../utils/backoff.js';
import { __resetDbForTests, getDb } from '../ledger/db.js';
import type { LedgerEvent } from '../ledger/events.js';
import { ingestionResponse, readJson, type IngestionItemError } from './api.js';
import { formatEventForLangfuse, type LangfuseQueuePayload } from './format.js';

/** Flushes a queue row may be rejected before it is parked in langfuse_dead_letter. */
const MAX_ROW_ATTEMPTS = 5;
/** A claim older than this was left by a process that died mid-flush (one flush is seconds); it is released. */
const CLAIM_STALE_MS = 10 * 60 * 1000;

function describeItemError(e: IngestionItemError): string {
  const detail = e.message ?? (typeof e.error === 'string' ? e.error : e.error === undefined ? '' : JSON.stringify(e.error));
  return `status=${e.status ?? 'unknown'} ${detail}`.trim();
}

export class LangfuseSink {
  static _warnedMissingKeys = false;
  
  static hasValidConfig(): boolean {
    const hasKeys = CONFIG.LANGFUSE_PUBLIC_KEY || CONFIG.LANGFUSE_SECRET_KEY || CONFIG.LANGFUSE_HOST;
    const hasAllKeys = CONFIG.LANGFUSE_PUBLIC_KEY && CONFIG.LANGFUSE_SECRET_KEY && CONFIG.LANGFUSE_HOST;
    
    if (hasAllKeys) {
      return true;
    } else if (hasKeys && !this._warnedMissingKeys) {
      log.warn('ledger', 'Langfuse needs LANGFUSE_PUBLIC_KEY + SECRET_KEY + HOST; running ledger-only');
      this._warnedMissingKeys = true;
    }
    return false;
  }

  static mirrorEvent(e: LedgerEvent) {
    try {
      const payload = formatEventForLangfuse(e);
      const statement = getDb().prepare('INSERT INTO langfuse_queue (payload) VALUES (?)');
      statement.run(JSON.stringify(payload));
    } catch (err) {
      log.error('ledger', 'Failed to queue langfuse event', { error: err });
    }
  }

  /**
   * Ship queued Langfuse payloads.
   *
   * Drains to empty rather than a single fixed-size page: the previous `LIMIT 50` with no
   * loop meant throughput was capped at 50 events per invocation, so a backlog could never
   * catch up. Rows are only deleted after the server accepts them, so a failure leaves the
   * queue intact and the offline contract holds.
   *
   * Langfuse answers 207 when it takes the batch but rejects single items. A row is deleted
   * only when every one of its items was accepted; a rejected row stays queued with its
   * attempt count raised, and after MAX_ROW_ATTEMPTS it moves to langfuse_dead_letter so it
   * cannot block the queue. Each row is sent at most once per call, so a rejection costs one
   * attempt per flush, not one per batch.
   *
   * @param options.maxBatches Safety valve so a pathological queue cannot spin forever.
   * @param options.deadlineMs Wall-clock budget; used by the shutdown drain, where MCP hosts
   *   force-kill after a short grace period.
   * @returns Number of queue rows successfully shipped.
   */
  static async flushQueue(options: { maxBatches?: number; deadlineMs?: number } = {}): Promise<number> {
    if (!this.hasValidConfig()) return 0;

    const { maxBatches = 100, deadlineMs } = options;
    const startedAt = Date.now();
    const db = getDb();
    const MAX_ATTEMPTS = 3;
    let shipped = 0;
    // Rows at or below this id were already sent during this call.
    let lastId = 0;

    // Both gates flush this queue. A batch is claimed (synced = 1) in one statement so the other process
    // skips it, and released when it is not accepted. A claim left by a process that died mid-flight is
    // released here once it is older than any flush could run.
    db.prepare('UPDATE langfuse_queue SET synced = 0, claimed_at = NULL WHERE synced = 1 AND (claimed_at IS NULL OR claimed_at < ?)')
      .run(new Date(Date.now() - CLAIM_STALE_MS).toISOString());
    const release = (ids: number[]) => {
      if (ids.length === 0) return;
      db.prepare(`UPDATE langfuse_queue SET synced = 0, claimed_at = NULL WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    };

    for (let batchNo = 0; batchNo < maxBatches; batchNo++) {
      if (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs) {
        log.warn('ledger', 'Langfuse flush hit its time budget; remaining rows stay queued.');
        break;
      }

      // ORDER BY id so the oldest events drain first and ordering is deterministic (RETURNING itself gives no order).
      const rows = (db
        .prepare('UPDATE langfuse_queue SET synced = 1, claimed_at = ? WHERE id IN (SELECT id FROM langfuse_queue WHERE synced = 0 AND id > ? ORDER BY id ASC LIMIT 50) RETURNING id, payload, attempts')
        .all(new Date().toISOString(), lastId) as { id: number; payload: string; attempts: number | null }[])
        .sort((a, b) => a.id - b.id);

      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id;

      const batch: Array<{ id: string; type: string; timestamp: string; body: unknown }> = [];
      const rowIds = [];
      // Each batch item's id → the queue row it came from, so a per-item error in a 207
      // response can be traced back to the one row that must stay queued.
      const rowIdByItemId = new Map<string, number>();

      for (const row of rows) {
        rowIds.push(row.id);
        const payload = JSON.parse(row.payload) as LangfuseQueuePayload;

        // Langfuse stamps the ingestion ENVELOPE, not the body. ScoreBody has no timestamp
        // field at all, so without this every score lands at flush time and the whole time
        // series collapses onto a few instants — which is what broke the date filters.
        const envelopeTs = payload.eventTs ?? payload.trace?.timestamp ?? new Date().toISOString();
        const add = (item: { type: string; body: unknown }) => {
          const id = crypto.randomUUID();
          rowIdByItemId.set(id, row.id);
          batch.push({ id, type: item.type, timestamp: envelopeTs, body: item.body });
        };

        add({ type: 'trace-create', body: payload.trace });

        const generations = payload.generations || (payload.generation ? [payload.generation] : []);
        for (const gen of generations) {
          add({ type: 'generation-create', body: { ...gen, traceId: payload.trace.id } });
        }

        if (payload.scores && Array.isArray(payload.scores)) {
          for (const score of payload.scores) {
            add({ type: 'score-create', body: { ...score, traceId: payload.trace.id } });
          }
        }

        if (payload.span) {
          add({ type: 'span-create', body: { ...payload.span, traceId: payload.trace.id } });
        }
      }

      let accepted = false;
      let itemErrors: IngestionItemError[] = [];
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !accepted; attempt++) {
        try {
          const auth = Buffer.from(`${CONFIG.LANGFUSE_PUBLIC_KEY}:${CONFIG.LANGFUSE_SECRET_KEY}`).toString('base64');
          const res = await fetch(`${CONFIG.LANGFUSE_HOST}/api/public/ingestion`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ batch }),
            signal: AbortSignal.timeout(LANGFUSE_REQUEST_TIMEOUT_MS),
          });

          const body = await readJson({ res, schema: ingestionResponse, scope: 'ledger', what: 'ingestion' });

          for (const e of body?.errors ?? []) {
            log.warn('ledger', 'Langfuse per-item error', { id: e.id ?? 'unknown', detail: describeItemError(e) });
          }

          if (res.ok) {
            accepted = true;
            itemErrors = body?.errors ?? [];
            break;
          }

          // 429 and 5xx are transient: back off and retry the same batch. Anything else is
          // a permanent rejection (bad payload, bad auth) that retrying cannot fix.
          const isTransient = res.status === 429 || res.status >= 500;
          const errText = body ? JSON.stringify(body) : '(no body)';
          if (!isTransient) {
            log.warn('ledger', `Langfuse ingestion rejected (${res.status}): ${errText}`);
            break;
          }
          if (attempt < MAX_ATTEMPTS - 1) {
            await waitWithBackoff({ attempt, maxRetries: MAX_ATTEMPTS, reason: `Langfuse ingestion ${res.status}`, retryAfter: res.headers.get('retry-after'), layer: 'ledger' });
          } else {
            log.warn('ledger', `Langfuse ingestion failed after ${MAX_ATTEMPTS} attempts (${res.status}): ${errText}`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt < MAX_ATTEMPTS - 1) {
            await waitWithBackoff({ attempt, maxRetries: MAX_ATTEMPTS, reason: `Langfuse network error (${message})`, retryAfter: null, layer: 'ledger' });
          } else {
            log.warn('ledger', `Langfuse network flush failed: ${message}`);
          }
        }
      }

      if (!accepted) { release(rowIds); break; } // leave rows queued for the next attempt

      // An error that names no item of this batch cannot be pinned to a row, so every row
      // in the batch is treated as rejected: resending is harmless (every id is an upsert),
      // deleting an unaccepted row is silent data loss.
      const rejections = new Map<number, string[]>();
      for (const e of itemErrors) {
        const rowId = e.id === undefined ? undefined : rowIdByItemId.get(e.id);
        for (const id of rowId === undefined ? rowIds : [rowId]) {
          rejections.set(id, [...(rejections.get(id) ?? []), describeItemError(e)]);
        }
      }

      const acceptedIds = rowIds.filter(id => !rejections.has(id));
      db.transaction(() => {
        if (acceptedIds.length > 0) {
          const placeholders = acceptedIds.map(() => '?').join(',');
          db.prepare(`DELETE FROM langfuse_queue WHERE id IN (${placeholders})`).run(...acceptedIds);
        }
        for (const row of rows) {
          const errors = rejections.get(row.id);
          if (!errors) continue;
          const attempts = (row.attempts ?? 0) + 1;
          if (attempts < MAX_ROW_ATTEMPTS) {
            db.prepare('UPDATE langfuse_queue SET attempts = ?, synced = 0, claimed_at = NULL WHERE id = ?').run(attempts, row.id);
            continue;
          }
          db.prepare('INSERT OR REPLACE INTO langfuse_dead_letter (id, payload, attempts, error, dead_at) VALUES (?, ?, ?, ?, ?)')
            .run(row.id, row.payload, attempts, errors.join('\n'), new Date().toISOString());
          db.prepare('DELETE FROM langfuse_queue WHERE id = ?').run(row.id);
          log.warn('ledger', `Langfuse rejected queue row ${row.id} ${attempts} times; moved it to langfuse_dead_letter`, { last_error: errors[0] });
        }
      })();
      shipped += acceptedIds.length;
    }

    return shipped;
  }

  /**
   * Test-only utility to reset the internal client state.
   */
  static __resetForTests() {
    __resetDbForTests();
  }
}
