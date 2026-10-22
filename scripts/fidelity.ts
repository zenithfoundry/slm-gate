/**
 * `pnpm run fidelity` — the offline skill-shrinking fidelity bench. Real local models, no API key.
 *
 * Corpus (fixed): every distinct skill text in the live ledger's `elision_cache` whose tool name passes the same
 * generic /skill/i test the distiller uses and that is over 8,000 bytes, snapshotted by content hash to
 * `output/fidelity-corpus.json` on the first run (`--refresh` rewrites the snapshot), plus the three generic
 * fixtures in `tests/fixtures/skills`. The live ledger is opened read-only; this bench writes its own cache and
 * rows to `output/fidelity-bench.sqlite`, under a fresh PROMPT_VERSION each run so nothing is served from cache.
 *
 * Each entry ends in exactly one outcome:
 *   pass              compressed, every check passed, under budget — this text would be cached and sent
 *   deterministic_fail a protected block or tracked token went missing (the original was sent instead)
 *   recall_fail       the brain reported a requirement sentence missing in some run (that run stayed verbatim)
 *   model_error       a local-model call failed
 *   timeout           a local-model call timed out
 *   not_shrunk        checks passed but the skill is still over budget: sent as the original, cut with a marker
 * Exit 1 unless deterministic_fail = recall_fail = model_error = timeout = 0. `not_shrunk` is reported, not failed:
 * the skill is unchanged from today and the list is the authors' to-do for verbatim markers or shorter prose.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config as loadEnv } from 'dotenv';

const refresh = process.argv.includes('--refresh');
/** `--json`: one JSON object on stdout instead of the table, for `scripts/bench-gate.ts`. */
const asJson = process.argv.includes('--json');
const say = (line: string) => { if (!asJson) console.log(line); };
const liveEnv = loadEnv({ path: '.env', processEnv: {} }).parsed ?? {};
const liveLedger = process.env.FIDELITY_LIVE_LEDGER ?? liveEnv.LEDGER_PATH ?? path.join('output', 'ledger.sqlite');
const outDir = 'output';
const snapshotPath = path.join(outDir, 'fidelity-corpus.json');

// This bench's own ledger and a run-unique version: set before config loads.
fs.mkdirSync(outDir, { recursive: true });
process.env.LEDGER_PATH = path.join(outDir, 'fidelity-bench.sqlite');
process.env.DISTILL_SKILLS = 'on';
process.env.PROMPT_VERSION = `fidelity-${Date.now()}`;

const { CONFIG } = await import('../src/config.js');
const { SLM } = await import('../src/models/slm.js');
const { buildPreserveList } = await import('../src/utils/preserve-patterns.js');
const { distillToolResultWithStats, estimateTokens } = await import('../src/utils/elision.js');
const { checkKept, compressNarrativeRun } = await import('../src/models/reasoning.js');
const { learnedProtections } = await import('../src/ledger/index.js');

type Entry = { id: string; source: 'elision_cache' | 'fixture'; hash?: string; file?: string };
type Outcome = 'pass' | 'deterministic_fail' | 'recall_fail' | 'model_error' | 'timeout' | 'not_shrunk';

const SKILL_TOOL = /skill/i;
const fixturesDir = path.join('tests', 'fixtures', 'skills');

/** Content hashes of every distinct cached skill text in the live ledger (read-only), by the generic tool-name test. */
function liveSkillHashes(): string[] {
  if (!fs.existsSync(liveLedger)) return [];
  const db = new Database(liveLedger, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT DISTINCT content_hash, tool_name FROM elision_cache WHERE size_bytes > 8000').all() as { content_hash: string; tool_name: string }[];
    return rows.filter(r => SKILL_TOOL.test(r.tool_name)).map(r => r.content_hash);
  } finally {
    db.close();
  }
}

/** The original text behind one content hash, read from the live ledger at run time (the snapshot stores hashes only). */
function liveText(hash: string): string | null {
  const db = new Database(liveLedger, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT original_text FROM elision_cache WHERE content_hash = ? LIMIT 1').get(hash) as { original_text: string } | undefined;
    return row?.original_text ?? null;
  } finally {
    db.close();
  }
}

/**
 * The fixed corpus: the snapshot's cached skill texts (written on the first run or with `--refresh`) plus every
 * fixture in tests/fixtures/skills. Stable between runs, so a pass line means the same thing tomorrow.
 */
function corpus(): Entry[] {
  let entries: Entry[];
  if (!refresh && fs.existsSync(snapshotPath)) {
    entries = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as Entry[];
  } else {
    entries = liveSkillHashes().map(hash => ({ id: hash.slice(0, 12), source: 'elision_cache' as const, hash }));
    fs.writeFileSync(snapshotPath, JSON.stringify(entries, null, 2) + '\n');
    say(`snapshot written: ${snapshotPath} (${entries.length} cached skill texts)`);
  }
  for (const file of fs.readdirSync(fixturesDir).filter(f => f.endsWith('.md')).sort()) {
    entries.push({ id: file.replace(/\.md$/, ''), source: 'fixture', file: path.join(fixturesDir, file) });
  }
  return entries;
}

/**
 * One outcome per entry, most serious first: a local-model failure, then a lost protected block or token, then
 * a run the brain found lossy, then a skill still over budget, else pass. Only the first four fail the bench.
 */
function outcomeOf(result: Awaited<ReturnType<typeof distillToolResultWithStats>>['fidelity']): Outcome {
  // A local-model failure inside the distiller keeps that run verbatim (safe) but is still a failed bench entry.
  if (result.errors.length > 0) return result.errors.some(e => /timed out|timeout/i.test(e)) ? 'timeout' : 'model_error';
  if (result.deterministic === 0) return 'deterministic_fail';
  if (result.recall !== null && result.recall < CONFIG.DISTILL_FIDELITY_MIN) return 'recall_fail';
  if (result.mode === 'not_shrunk') return 'not_shrunk';
  return 'pass';
}

const slm = new SLM();
const patterns = await buildPreserveList();
const entries = corpus();
const counts: Record<Outcome, number> = { pass: 0, deterministic_fail: 0, recall_fail: 0, model_error: 0, timeout: 0, not_shrunk: 0 };
const rows: { id: string; outcome: Outcome; mode: string; recall: string; lost: number; runs: string; ms: number; tokens: string }[] = [];
const worst: { id: string; recall: number }[] = [];

say(`fidelity bench: ${entries.length} entries, brain ${CONFIG.SLM_BRAIN_MODEL}, gate ${CONFIG.SLM_GATE_MODEL}, concurrency ${CONFIG.MAX_CONCURRENT_SEGMENT_CALLS}, min recall ${CONFIG.DISTILL_FIDELITY_MIN}`);
for (const entry of entries) {
  const text = entry.source === 'fixture' ? fs.readFileSync(entry.file!, 'utf8') : liveText(entry.hash!);
  if (text === null) { console.warn(`${entry.id}: no longer in the live ledger, skipped`); continue; }
  const started = Date.now();
  try {
    const { text: out, fidelity } = await distillToolResultWithStats({
      slm: (t, task) => compressNarrativeRun({ slm, text: t, task }),
      text, task: 'fidelity bench', toolName: 'get_skill', args: { bench: entry.id }, preservePatterns: patterns,
      verify: ({ inventory, compressed }) => checkKept({ slm, inventory, compressed }),
    });
    const outcome = outcomeOf(fidelity);
    counts[outcome]++;
    for (const e of fidelity.errors) console.error(`${entry.id}: ${e}`);
    if (fidelity.recall !== null) worst.push({ id: entry.id, recall: fidelity.recall });
    rows.push({
      id: entry.id, outcome, mode: fidelity.mode, recall: fidelity.recall === null ? '-' : fidelity.recall.toFixed(2), lost: fidelity.lost.length,
      runs: `${fidelity.runsChecked}/${fidelity.runs}`, ms: Date.now() - started, tokens: `${estimateTokens(text)}→${estimateTokens(out)}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome: Outcome = /timed out|timeout/i.test(message) ? 'timeout' : 'model_error';
    counts[outcome]++;
    rows.push({ id: entry.id, outcome, mode: '-', recall: '-', lost: 0, runs: '-', ms: Date.now() - started, tokens: `${estimateTokens(text)}→?` });
    console.error(`${entry.id}: ${outcome}: ${message}`);
  }
  const last = rows[rows.length - 1];
  say(`${last.id.padEnd(18)} ${last.outcome.padEnd(18)} ${last.mode.padEnd(11)} recall ${last.recall.padStart(4)} lost ${String(last.lost).padStart(2)} runs ${last.runs.padStart(5)} ${String(last.ms).padStart(6)} ms ${last.tokens}`);
}

const failed = counts.deterministic_fail + counts.recall_fail + counts.model_error + counts.timeout;
const notShrunkMode = rows.filter(r => r.mode === 'not_shrunk').length;
if (asJson) {
  console.log(JSON.stringify({ gate: CONFIG.SLM_GATE_MODEL, brain: CONFIG.SLM_BRAIN_MODEL, concurrency: CONFIG.MAX_CONCURRENT_SEGMENT_CALLS, counts, notShrunkMode, rows }));
} else {
  say(`\nfidelity: ${rows.length} entries — pass ${counts.pass}, deterministic_fail ${counts.deterministic_fail}, recall_fail ${counts.recall_fail}, model_error ${counts.model_error}, timeout ${counts.timeout}, not_shrunk ${counts.not_shrunk} (sent as the original after shrinking: ${notShrunkMode})`);
  if (worst.length) say(`lowest recall: ${worst.sort((a, b) => a.recall - b.recall).slice(0, 3).map(w => `${w.id} ${(w.recall * 100).toFixed(0)}%`).join(' · ')}`);
  say(`learned protections in this bench ledger: ${learnedProtections().length} (the live ledger learns on real traffic; see pnpm run protections)`);
  if (notShrunkMode) say(`not shrunk (authors' to-do for <!-- slm-gate:verbatim-start/end --> markers or shorter prose): ${rows.filter(r => r.mode === 'not_shrunk').map(r => r.id).join(', ')}`);
}
process.exit(failed > 0 ? 1 : 0);
