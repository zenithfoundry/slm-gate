/**
 * `pnpm run bench:gate` — which gate model, and how many runs at once (slice 9).
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
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim().split('\n').pop() ?? '{}';
  return JSON.parse(out) as CellResult;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};

console.log(`bench:gate — models ${models.join(', ')} × concurrency ${concurrencies.join(', ')} (brain stays as configured)\n`);
console.log('gate model            conc  p50 ms   p95 ms  recall  determ  tokens before→after (avg)   pass/fail/not_shrunk/unchanged');
for (const gate of models) {
  for (const concurrency of concurrencies) {
    let cell: CellResult;
    try {
      cell = runCell(gate, concurrency);
    } catch (err) {
      // The bench exits 1 on any fidelity failure but still prints its JSON line; recover it from the error.
      const stdout = (err as { stdout?: string }).stdout ?? '';
      const line = stdout.trim().split('\n').pop();
      if (!line || !line.startsWith('{')) { console.error(`${gate} ×${concurrency}: bench did not run: ${err instanceof Error ? err.message : String(err)}`); continue; }
      cell = JSON.parse(line) as CellResult;
    }
    const ms = cell.rows.map(r => r.ms);
    const recalls = cell.rows.map(r => Number(r.recall)).filter(n => !Number.isNaN(n));
    const measured = cell.rows.filter(r => r.mode === 'summarize' || r.mode === 'not_shrunk');
    const determ = measured.length ? measured.filter(r => r.outcome !== 'deterministic_fail').length / measured.length : null;
    const before = cell.rows.map(r => Number(r.tokens.split('→')[0])).filter(n => !Number.isNaN(n));
    const after = cell.rows.map(r => Number(r.tokens.split('→')[1])).filter(n => !Number.isNaN(n));
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);
    const failed = (cell.counts.deterministic_fail ?? 0) + (cell.counts.recall_fail ?? 0) + (cell.counts.model_error ?? 0) + (cell.counts.timeout ?? 0);
    console.log(
      `${gate.padEnd(21)} ${String(concurrency).padStart(4)}  ${String(percentile(ms, 0.5)).padStart(6)}   ${String(percentile(ms, 0.95)).padStart(6)}  ` +
      `${(recalls.length ? (recalls.reduce((s, r) => s + r, 0) / recalls.length).toFixed(2) : '   -').padStart(6)}  ` +
      `${(determ === null ? '-' : `${Math.round(determ * 100)}%`).padStart(6)}  ${`${avg(before)}→${avg(after)}`.padEnd(27)} ${cell.counts.pass ?? 0}/${failed}/${cell.notShrunkMode}/${cell.counts.unchanged ?? 0}`,
    );
  }
}
console.log('\nNothing was changed. Set SLM_GATE_MODEL and MAX_CONCURRENT_SEGMENT_CALLS in .env to adopt a cell.');
