import { getDb } from '../src/ledger/index.js';

async function main() {
  console.log('--- Local SQLite Ledger Metrics ---');
  const db = getDb();

  const rows = db.prepare(`
    SELECT 
      slm_gate,
      SUM(cost_usd) as total_cost_usd,
      SUM(in_tok + out_tok + api_in_tok + api_out_tok) as total_tokens,
      AVG(quality_score) as avg_quality_score,
      COUNT(request_id) as row_count
    FROM events
    WHERE slm_gate IN ('on', 'off')
    GROUP BY slm_gate
  `).all() as {
    slm_gate: string;
    total_cost_usd: number | null;
    total_tokens: number | null;
    avg_quality_score: number | null;
    row_count: number;
  }[];

  const metrics = {
    on: { cost: 0, tokens: 0, quality: 0, count: 0 },
    off: { cost: 0, tokens: 0, quality: 0, count: 0 },
  };

  for (const row of rows) {
    if (row.slm_gate === 'on' || row.slm_gate === 'off') {
      metrics[row.slm_gate] = {
        cost: row.total_cost_usd ?? 0,
        tokens: row.total_tokens ?? 0,
        quality: row.avg_quality_score ?? 0,
        count: row.row_count,
      };
    }
  }

  const table = [
    {
      Arm: 'slm_gate=off (Baseline)',
      'Cost (USD)': metrics.off.cost.toFixed(4),
      'Tokens': metrics.off.tokens,
      'Avg Quality': metrics.off.quality.toFixed(2),
      'Count': metrics.off.count
    },
    {
      Arm: 'slm_gate=on (Router)',
      'Cost (USD)': metrics.on.cost.toFixed(4),
      'Tokens': metrics.on.tokens,
      'Avg Quality': metrics.on.quality.toFixed(2),
      'Count': metrics.on.count
    }
  ];

  console.table(table);

  // No "on minus off" delta and no Langfuse totals. The arms hold different numbers of rows
  // (the "on" arm also carries every real MCP event), so subtracting their totals printed a
  // meaningless negative as "Tokens Saved"; and the Langfuse query filtered observations on
  // trace tags and a score name ('task_pass') nothing writes, so it printed confident zeros.
  console.log('\nThe arms hold different numbers of rows, so their totals are not comparable.');
  console.log('Tokens saved per event, per day and all-time: pnpm run ledger:report');
  console.log('Benchmark comparison on the same prompts: pnpm run bench (see harness/README.md)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
