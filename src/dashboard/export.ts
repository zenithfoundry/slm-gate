/**
 * @fileoverview Bakes the dashboard into a static site for free hosting (GitHub Pages).
 *
 * Writes <out>/index.html (the same page the local server serves), <out>/data.json
 * (aggregates only: counts, token sums, minutes, dates — no prompts, tool names or
 * skill names, so it is safe to publish; the timestamps do reveal when you work),
 * and <out>/.nojekyll.
 *
 * Usage:
 *   pnpm run dashboard:export [-- --out site]
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { isEntryPoint } from '../utils/entry-point.js';
import { computeDashboardData, loadDashboardData } from './data.js';
import { otherGateLedger, otherLedgerMessage } from './gate-ledger.js';

async function main(): Promise<void> {
  // Refuse rather than warn: the daily publish job runs unattended, and a warning in its log went unseen while
  // the public page showed a near-empty ledger in place of real savings.
  const gateLedger = await otherGateLedger();
  if (gateLedger) throw new Error(otherLedgerMessage(gateLedger));

  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = path.resolve(CONFIG.ROOT_DIR, outIdx >= 0 ? args[outIdx + 1] : 'site');

  // No ledger yet (a fresh install, or right after `ledger:reset`) means no events, so publish zeros.
  // Said on stderr so a wrong LEDGER_PATH is visible, even from scripts that discard stdout.
  const ledgerExists = fs.existsSync(CONFIG.LEDGER_PATH);
  if (!ledgerExists) console.warn(`No ledger at ${CONFIG.LEDGER_PATH}; exporting zeros.`);
  const data = ledgerExists ? loadDashboardData() : computeDashboardData([]);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join(CONFIG.ROOT_DIR, 'src', 'dashboard', 'index.html'), path.join(outDir, 'index.html'));
  fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');

  console.log(`Exported ${data.realEvents + data.benchEvents} events of aggregates to ${outDir}/`);
  console.log('Contains numbers and dates only — no prompts, tool names or skill names.');
  console.log('\nTo publish on GitHub Pages:');
  console.log('  1. git add site && commit && push (the Pages workflow deploys site/ from main)');
  console.log('  2. Once, in the repository: Settings → Pages → Source: GitHub Actions');
  console.log('  3. Your dashboard: https://<owner>.github.io/<repo>/');
  console.log('\nOr view without hosting anything: open the page anywhere and drop this data.json on it.');
}

if (isEntryPoint(import.meta.url)) {
  main().catch(err => {
    console.error('dashboard:export failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
