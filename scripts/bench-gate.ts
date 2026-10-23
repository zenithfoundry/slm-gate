/**
 * `pnpm run bench:gate` — which gate model, and how many paragraphs at once.
 *
 * Runs the fidelity bench (`scripts/fidelity.ts --json`) once per grid cell in a child process, because CONFIG
 * is read once per process: gate model ∈ {the configured one, each `--model`} × concurrency ∈ {1, 2}. The
 * brain model stays as configured. Prints one row per cell: latency p50/p95 per entry, average recall, the
 * deterministic pass rate, tokens before→after, and the failure counts. Nothing in `.env` changes; the owner
 * reads the table and picks.
 *
 *   pnpm run bench:gate                              the configured gate model only
 *   pnpm run bench:gate -- --model qwen3.5:2b        also that model (repeat --model for more)
 *   pnpm run bench:gate -- --concurrency 1,2,3       other concurrency values
 *
 * Ollama keeps the brain plus one gate model resident; swapping the gate model evicts only the other gate
 * model. Each cell writes to the bench ledger with its own PROMPT_VERSION, so no cell is served from cache.
 */
import { execFileSync } from 'node:child_process';

// The gate model as config resolves it (env, .env, or the RAM preset), so the first cell is what runs today.
const { CONFIG } = await import('../src/config.js');
const configuredGate = CONFIG.SLM_GATE_MODEL;

const argAll = (flag: string): string[] => process.argv.flatMap((a, i) => (a === flag && process.argv[i + 1] ? [process.argv[i + 1]] : []));
const models = [configuredGate, ...argAll('--model').filter(m => m !== configuredGate)];
const concurrencies = (argAll('--concurrency')[0] ?? '1,2').split(',').map(n => Number(n.trim())).filter(n => Number.isInteger(n) && n > 0);

interface CellResult {
  gate: string;
  concurrency: number;
  counts: Record<string, number>;
  notShrunkMode: number;
  rows: { outcome: string; recall: string; ms: number; tokens: string; mode: string }[];
}

/** Runs one grid cell and parses the bench's JSON line (the last stdout line). */
function runCell(gate: string, concurrency: number): CellResult {
  const out = execFileSync('node', ['--import', 'tsx', 'scripts/fidelity.ts', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SLM_GATE_MODEL: gate, MAX_CONCURRENT_SEGMENT_CALLS: String(concurrency) },
    // The distiller's per-skill log lines ("summarize left ~N tokens…") go to stderr; they are noise in a
    // table run, so they are captured and shown only when a cell cannot be read.
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split('\n').pop() ?? '{}';
  return JSON.parse(out) as CellResult;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};

console.log(`bench:gate — models ${models.join(', ')} × concurrency ${concurrencies.join(', ')} (brain stays as configured)\n`);
console.log('gate model            conc  p50 ms   p95 ms  recall  determ  tokens before→after (avg)   pass/fail/not_shrunk/unchanged/recall_caught');

interface Scored { gate: string; concurrency: number; p50: number; recall: number | null; determ: number | null; failed: number; shrunk: number; saved: number }
const scored: Scored[] = [];

for (const gate of models) {
  for (const concurrency of concurrencies) {
    let cell: CellResult;
    process.stderr.write(`running ${gate} ×${concurrency} …\n`);
    try {
      cell = runCell(gate, concurrency);
    } catch (err) {
      // The bench exits 1 on a guard or model failure but still prints its JSON line; recover it from the error.
      const stdout = String((err as { stdout?: string | Buffer }).stdout ?? '');
      const line = stdout.trim().split('\n').pop();
      if (!line || !line.startsWith('{')) {
        const stderr = String((err as { stderr?: string | Buffer }).stderr ?? '').trim().split('\n').slice(-5).join('\n');
        console.error(`${gate} ×${concurrency}: bench did not run: ${err instanceof Error ? err.message : String(err)}\n${stderr}`);
        continue;
      }
      cell = JSON.parse(line) as CellResult;
    }
    const ms = cell.rows.map(r => r.ms);
    const recalls = cell.rows.map(r => Number(r.recall)).filter(n => !Number.isNaN(n));
    const measured = cell.rows.filter(r => r.mode === 'summarize' || r.mode === 'not_shrunk');
    const determ = measured.length ? measured.filter(r => r.outcome !== 'deterministic_fail').length / measured.length : null;
    const before = cell.rows.map(r => Number(r.tokens.split('→')[0])).filter(n => !Number.isNaN(n));
    const after = cell.rows.map(r => Number(r.tokens.split('→')[1])).filter(n => !Number.isNaN(n));
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);
    // Same rule as the fidelity bench: a caught recall failure is informational, not a failure.
    const failed = (cell.counts.deterministic_fail ?? 0) + (cell.counts.model_error ?? 0) + (cell.counts.timeout ?? 0);
    const recall = recalls.length ? recalls.reduce((s, r) => s + r, 0) / recalls.length : null;
    scored.push({ gate, concurrency, p50: percentile(ms, 0.5), recall, determ, failed, shrunk: cell.counts.pass ?? 0, saved: avg(before) - avg(after) });
    console.log(
      `${gate.padEnd(21)} ${String(concurrency).padStart(4)}  ${String(percentile(ms, 0.5)).padStart(6)}   ${String(percentile(ms, 0.95)).padStart(6)}  ` +
      `${(recall === null ? '   -' : recall.toFixed(2)).padStart(6)}  ` +
      `${(determ === null ? '-' : `${Math.round(determ * 100)}%`).padStart(6)}  ${`${avg(before)}→${avg(after)}`.padEnd(27)} ${cell.counts.pass ?? 0}/${failed}/${cell.notShrunkMode}/${cell.counts.unchanged ?? 0}/${cell.counts.recall_fail ?? 0}`,
    );
  }
}

// How to read the columns, then a recommendation: among cells with no failures and nothing lost, the one
// that shortened the most skills, fastest. The owner still decides; nothing in .env is changed here.
console.log(`
How to read it: p50/p95 = time per skill; recall = share of requirement sentences the brain confirmed kept
(1.00 = nothing missing; "-" = no paragraph was long enough to check); determ = share with every protected
line intact; the last column counts skills that were shortened / failed / still too long after shortening /
had nothing to shorten / had a lossy paragraph caught and kept word for word.`);

// A cell qualifies when nothing failed, every protected line survived, and no checked sentence was lost.
const clean = scored.filter(c => c.failed === 0 && (c.determ === null || c.determ === 1) && (c.recall === null || c.recall >= 1));
const best = [...clean].sort((a, b) => b.shrunk - a.shrunk || a.p50 - b.p50)[0];
if (best) {
  const current = scored.find(c => c.gate === configuredGate && c.concurrency === Number(CONFIG.MAX_CONCURRENT_SEGMENT_CALLS));
  const same = current && best.gate === current.gate && best.concurrency === current.concurrency;
  console.log(`\nRecommendation: ${best.gate} at concurrency ${best.concurrency}${same ? ' — what you run today; nothing to change.' : ':'}`);
  if (!same) {
    console.log(`  It shortened ${best.shrunk} skill(s) with nothing lost at ${best.p50} ms per skill` +
      (current ? ` (today: ${current.shrunk} skill(s) at ${current.p50} ms).` : '.'));
    console.log(`  To adopt it, put these two lines in .env and run \`slm-gate restart\`:\n    SLM_GATE_MODEL=${best.gate}\n    MAX_CONCURRENT_SEGMENT_CALLS=${best.concurrency}`);
    if (best.gate !== configuredGate) console.log(`  It is already pulled (the bench just ran it). Keep OLLAMA_MAX_LOADED_MODELS at 2; the old gate model is unloaded on the next pin check.`);
  }
} else {
  console.log('\nNo cell finished without a failure, so no recommendation; read the rows above.');
}

// The grid loaded gate models slm-gate does not normally use; put the configured two back so the running
// gate does not pay a reload on its next call (see src/models/pin.ts).
const { pinModels, describePin } = await import('../src/models/pin.js');
const pinned = await pinModels();
console.log(`\n${describePin(pinned) ?? '[models] both of slm-gate\'s models are loaded'}. Nothing in .env was changed.`);
