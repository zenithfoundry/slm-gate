/**
 * @fileoverview Conversation memory: the model gate's rolling summary of each conversation.
 *
 * Every local step in slm-gate answers from a single message; none knows what the conversation is about. The
 * model gate, though, receives the whole history on every request. This module turns that into something a
 * small model can hold: a few hundred tokens per conversation (goal, what was decided, what is in play), kept
 * current by folding only the NEW turns into the previous summary, never re-reading the history.
 *
 * Rules that matter (docs/briefs/2026-10-22-conversation-memory.md):
 *  - Off the request path. `noteTurn` only records the latest entries and marks the conversation dirty; the
 *    fold runs later, after MEMORY_FOLD_INTERVAL_MS, and only when this process has no request in flight and
 *    no local-model call running (src/models/busy.ts). It never changes a forwarded request.
 *  - A cursor, not a guess. The row's `turns` is the last entry the brain actually read. A fold reads the
 *    longest prefix of the new entries that fits MEMORY_FOLD_INPUT_TOKENS; the rest stays dirty for the next
 *    tick. A failed fold changes nothing but `fold_failed_at`, which makes the row invisible to readers until
 *    a later fold succeeds.
 *  - One identity per conversation. The key is the first user entry's hash; the second entry's hash tells
 *    two conversations with the same opening apart (a shorter history than the cursor means a fork, which
 *    starts its own row).
 *  - The text lives only in the `conversation_memory` table. Event rows carry numbers.
 */
import { CONFIG } from '../config.js';
import crypto from 'node:crypto';
import { markMemoryFoldFailed, readMemoryRow, writeEvent, writeMemoryRow, type MemoryRow } from '../ledger/index.js';
import { track, whenIdle } from '../models/busy.js';
import { foldSummary, MEMORY_SCHEMA, type MemorySummary } from '../models/reasoning.js';
import { SLM } from '../models/slm.js';
import { estimateTokens } from '../utils/elision.js';
import type { HistoryEntry } from './formats/contract.js';

/** The newest view of a conversation this process has seen, waiting to be folded. */
interface Pending {
  key: string;
  root: string | null;
  discriminator: string | null;
  entries: HistoryEntry[];
  /** When this process first saw the conversation: the row's started_at, set at the note, not at the fold. */
  firstSeen: string;
  timer: NodeJS.Timeout | null;
}

/**
 * Conversation text may only be folded by a model on THIS machine (constraint 10). The Ollama provider on a
 * loopback host qualifies; the OpenAI-style provider can point anywhere, so it never does. Checked once per
 * fold; when it fails nothing is folded and nothing is sent, and the reason is logged once.
 */
export function brainIsLocal(): boolean {
  if (CONFIG.SLM_PROVIDER !== 'ollama') return false;
  try {
    const host = new URL(CONFIG.OLLAMA_HOST).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}
let warnedNotLocal = false;

/** Conversations noted but not yet folded, newest last; bounded so a long-running gate cannot grow without limit. */
const pending = new Map<string, Pending>();
const MAX_PENDING = 20;
/** The fold queue: one at a time, in order. */
let queue: Promise<void> = Promise.resolve();
let slm: SLM | null = null;

/** Injected in tests; the real client otherwise. */
export function useMemoryClient(client: SLM | null): void {
  slm = client;
}

/** Renders the three-part summary as the text the local steps read. Pure. */
export function renderSummary(summary: MemorySummary): string {
  const lines = [`Goal: ${summary.goal}`];
  if (summary.decided.length) lines.push('Decided:', ...summary.decided.map(d => `- ${d}`));
  if (summary.inPlay.length) lines.push('In play:', ...summary.inPlay.map(i => `- ${i}`));
  return lines.join('\n');
}

/** Parses a stored summary back into its parts; null when the stored text is not ours. */
export function parseSummary(text: string): MemorySummary | null {
  try {
    return MEMORY_SCHEMA.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Trims a summary to MEMORY_MAX_TOKENS by dropping `inPlay` lines first, then the oldest `decided` lines. Pure.
 */
export function trimSummary(summary: MemorySummary, maxTokens = CONFIG.MEMORY_MAX_TOKENS): MemorySummary {
  const out: MemorySummary = { goal: summary.goal, decided: [...summary.decided], inPlay: [...summary.inPlay] };
  while (estimateTokens(renderSummary(out)) > maxTokens) {
    if (out.inPlay.length) out.inPlay.pop();
    else if (out.decided.length) out.decided.shift();
    else { out.goal = out.goal.slice(0, Math.max(40, out.goal.length - 40)); if (out.goal.length <= 40) break; }
  }
  return out;
}

/**
 * The new entries one fold will read: the longest prefix (oldest first) that fits the budget. A single entry
 * over the budget is cut at the budget, never skipped, so the cursor always advances. Pure.
 */
export function foldPrefix(fresh: HistoryEntry[], budgetTokens = CONFIG.MEMORY_FOLD_INPUT_TOKENS): { text: string; count: number } {
  const lines: string[] = [];
  let used = 0;
  let count = 0;
  for (const entry of fresh) {
    const label = entry.role === 'tool' ? `[tool ${entry.text.split(':')[0]}]` : `[${entry.role}]`;
    let line = `${label} ${entry.role === 'tool' ? entry.text.slice(entry.text.indexOf(':') + 1).trim() : entry.text}`;
    let cost = estimateTokens(line) + 1;
    if (used + cost > budgetTokens) {
      if (count > 0) break;
      // A single entry over the whole budget: shorten it until its estimated cost (label and separator
      // included) fits, by the same estimator the budget is checked with.
      while (cost > budgetTokens - used && line.length > label.length + 1) {
        line = line.slice(0, Math.max(label.length + 1, Math.floor(line.length * 0.8)));
        cost = estimateTokens(line) + 1;
      }
    }
    lines.push(line);
    used += cost;
    count++;
    if (used >= budgetTokens) break;
  }
  return { text: lines.join('\n'), count };
}

/**
 * Records the latest view of a conversation and schedules its fold. Cheap: a Map write and a timer. Called
 * by the model gate after a response is complete; never on the request path.
 */
export function noteTurn(params: { key: string; root: string | null; discriminator: string | null; entries: HistoryEntry[] }): void {
  if (!CONFIG.CONVERSATION_MEMORY) return;
  if (!brainIsLocal()) {
    if (!warnedNotLocal) { warnedNotLocal = true; console.error('[memory] off: the brain model is not on this machine (SLM_PROVIDER / OLLAMA_HOST), and conversation text never leaves it'); }
    return;
  }
  const { key, root, discriminator, entries } = params;
  const existing = pending.get(key);
  if (existing) {
    existing.entries = entries;
    existing.root = root ?? existing.root;
    existing.discriminator = discriminator ?? existing.discriminator;
    return; // the running timer folds everything new since the cursor
  }
  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) { const p = pending.get(oldest); if (p?.timer) clearTimeout(p.timer); pending.delete(oldest); }
  }
  const item: Pending = { key, root, discriminator, entries, firstSeen: new Date().toISOString(), timer: null };
  item.timer = setTimeout(() => { enqueueFold(key); }, CONFIG.MEMORY_FOLD_INTERVAL_MS);
  item.timer.unref();
  pending.set(key, item);
}

function enqueueFold(key: string): void {
  queue = queue
    .then(async () => { await foldConversation(key); })
    .catch(err => { console.error(`[memory] fold failed: ${err instanceof Error ? err.message : String(err)}`); });
}

/**
 * One fold for one conversation: waits for the process to be idle, reads the prefix of new entries, asks the
 * brain, and writes the row. Exported for tests; production reaches it through `noteTurn`'s timer.
 */
export async function foldConversation(key: string, options: { waitForIdle?: boolean } = {}): Promise<MemoryRow | null> {
  const item = pending.get(key);
  if (!item) return null;
  if (options.waitForIdle !== false) await whenIdle();
  pending.delete(key);
  if (item.timer) clearTimeout(item.timer);

  const stored = readMemoryRow(key);
  // A different conversation with the same opening is a fork: a history shorter than the cursor, or a second
  // user entry that differs from the stored one. It gets its own row under key:discriminator. Without a
  // discriminator (a one-message conversation) nothing can tell the two apart, so the existing row is left
  // alone and this view is dropped — never overwritten.
  const forked = stored !== null && (item.entries.length < stored.turns || (!!stored.discriminator && !!item.discriminator && stored.discriminator !== item.discriminator));
  if (forked && !item.discriminator) return stored;
  const rowKey = forked ? `${key}:${item.discriminator}` : key;
  const previous = forked ? readMemoryRow(rowKey) : stored;
  const cursor = previous?.turns ?? 0;
  const fresh = item.entries.slice(cursor);
  if (fresh.length === 0) return previous;

  const prefix = foldPrefix(fresh);
  const previousSummary = previous ? parseSummary(previous.summary) : null;
  const started = Date.now();
  const now = new Date().toISOString();
  try {
    const client = slm ?? (slm = new SLM());
    const folded = await track(foldSummary({ slm: client, previous: previousSummary, fresh: prefix.text }));
    const summary = trimSummary(folded);
    const row: Omit<MemoryRow, 'fold_failed_at'> = {
      key: rowKey,
      root: item.root ?? previous?.root ?? null,
      summary: JSON.stringify(summary),
      turns: cursor + prefix.count,
      discriminator: item.discriminator ?? previous?.discriminator ?? null,
      started_at: previous?.started_at ?? item.firstSeen,
      folded_at: now,
      fold_count: (previous?.fold_count ?? 0) + 1,
      fold_ms: Date.now() - started,
      prompt_version: CONFIG.PROMPT_VERSION,
    };
    writeMemoryRow(row);
    recordFold({ rowKey, inputText: prefix.text, outputText: row.summary, startedMs: started, outcome: 'ok', turns: row.turns });
    // More new entries than one fold could read: keep them pending for the next tick.
    if (prefix.count < fresh.length) noteTurn({ key, root: item.root, discriminator: item.discriminator, entries: item.entries });
    return { ...row, fold_failed_at: null };
  } catch (err) {
    markMemoryFoldFailed(rowKey, now);
    recordFold({ rowKey, inputText: prefix.text, outputText: '', startedMs: started, outcome: /timed out|timeout/i.test(String(err)) ? 'timeout' : 'error', turns: cursor });
    // Keep the entries so the next tick retries from the same cursor.
    noteTurn({ key, root: item.root, discriminator: item.discriminator, entries: item.entries });
    console.error(`[memory] fold of ${key.slice(0, 12)} failed, previous summary kept: ${err instanceof Error ? err.message : String(err)}`);
    return previous;
  }
}

/**
 * One ledger row per fold (route `memory_fold`): its latency and token estimate, success or failure, so the
 * cost of remembering is visible in the metrics. Numbers and labels only; never the text.
 */
function recordFold(params: { rowKey: string; inputText: string; outputText: string; startedMs: number; outcome: 'ok' | 'timeout' | 'error'; turns: number }): void {
  try {
    writeEvent({
      ts: new Date().toISOString(),
      layer: 'llm',
      request_id: `fold_${crypto.randomUUID()}`,
      route: 'memory_fold',
      is_local_call: 1,
      slm_model: CONFIG.SLM_BRAIN_MODEL,
      in_tok: estimateTokens(params.inputText),
      out_tok: estimateTokens(params.outputText),
      api_in_tok: 0,
      api_out_tok: 0,
      cost_usd: 0,
      slm_latency_s: (Date.now() - params.startedMs) / 1000,
      api_latency_s: 0,
      slm_gate: 'on',
      meta: JSON.stringify({ type: 'memory_fold', key: params.rowKey.slice(0, 12), outcome: params.outcome, turns: params.turns }),
    } as any);
  } catch (err) {
    console.error(`[memory] fold not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** For tests: whether a conversation is waiting to fold. */
export function isPending(key: string): boolean {
  return pending.has(key);
}

/** For tests: drop every pending conversation and its timer. */
export function resetMemoryQueue(): void {
  for (const item of pending.values()) if (item.timer) clearTimeout(item.timer);
  pending.clear();
}
