/**
 * `pnpm run protections` — the learned protections of the skill-shrinking guard (slice 5b).
 *
 * Lists every sentence the brain model once reported missing from a shortened skill run (ledger table
 * `distill_protect`): lines containing one are protected by code on every later run. The list grows with use;
 * this is the owner's editor for it.
 *
 *   pnpm run protections                       list, most often hit first
 *   pnpm run protections -- --forget "<text>"  remove one (raw or normalised form)
 */
const forgetAt = process.argv.indexOf('--forget');
const { listProtections, forgetProtection } = await import('../src/ledger/index.js');

if (forgetAt > -1) {
  const pattern = process.argv[forgetAt + 1];
  if (!pattern) {
    console.error('usage: pnpm run protections -- --forget "<sentence>"');
    process.exit(2);
  }
  console.log(forgetProtection(pattern) ? `forgotten: ${pattern}` : `not found: ${pattern}`);
} else {
  const rows = listProtections();
  if (rows.length === 0) {
    console.log('no learned protections yet (they appear once DISTILL_SKILLS=on and the brain reports a lost sentence)');
  } else {
    console.log(`${rows.length} learned protection(s)\n`);
    for (const row of rows) console.log(`${String(row.hits).padStart(4)} ×  ${row.last_seen.slice(0, 10)}  ${row.tool_name ?? '-'}  ${row.pattern}`);
  }
}
