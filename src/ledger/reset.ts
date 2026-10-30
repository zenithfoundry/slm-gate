/**
 * `slm-gate ledger:reset --yes`: deletes the local ledger (the SQLite file CONFIG.LEDGER_PATH names, with
 * its WAL and shared-memory files) so the gates start a new one. Runs as its own process because the CLI
 * never loads the configuration itself (src/cli.ts). Refuses without `--yes`: the ledger is every saving
 * ever measured, and there is no undo.
 */
import fs from 'node:fs';
import { CONFIG } from '../config.js';

const files = ['', '-wal', '-shm'].map(suffix => `${CONFIG.LEDGER_PATH}${suffix}`);

if (!process.argv.includes('--yes')) {
  console.error(`This deletes the ledger at ${CONFIG.LEDGER_PATH} (every request and saving recorded so far) and cannot be undone.`);
  console.error('Run it again with --yes to go ahead.');
  process.exit(1);
}

for (const file of files) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
console.log(`Deleted the ledger at ${CONFIG.LEDGER_PATH}. The next request starts a new one.`);
