/**
 * `slm-gate memory` — what the local model currently remembers of each conversation.
 *
 * Prints every conversation_memory row, newest fold first: a short key, the workspace, how many turns the
 * summary covers, when it was folded (and whether the newest fold failed), and the summary itself. This is the
 * only place the summary text is shown; it never goes to the ledger's event rows or to Langfuse.
 */
import { listMemoryRows } from '../ledger/index.js';
import { CONFIG } from '../config.js';
import { parseSummary, renderSummary } from './memory.js';

const rows = listMemoryRows();
console.log(`conversation memory: ${CONFIG.CONVERSATION_MEMORY ? 'on' : 'off'} — ${rows.length} conversation(s) remembered`);
for (const row of rows) {
  const failed = row.fold_failed_at && row.fold_failed_at >= row.folded_at ? ` — newest fold FAILED at ${row.fold_failed_at.slice(0, 19)}, this summary is not used until a fold succeeds` : '';
  console.log(`\n${row.key.slice(0, 12)}  ${row.root ?? '(no workspace)'}  turns ${row.turns}  folds ${row.fold_count}  last ${row.folded_at.slice(0, 19)} (${row.fold_ms ?? '?'} ms)${failed}`);
  const parsed = parseSummary(row.summary);
  console.log(parsed ? renderSummary(parsed).split('\n').map(l => '  ' + l).join('\n') : '  ' + row.summary);
}
