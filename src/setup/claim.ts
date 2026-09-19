/**
 * @fileoverview "At most once per time window, across every slm-gate process on this machine." Several
 * copies of slm-gate's MCP server run at once (one per IDE window / CLI session); this is how they agree
 * that only one of them shows a notification or launches the model gate.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * True for exactly one caller per window. Windows are fixed slices of time (with a minute: 12:00–12:01,
 * 12:01–12:02, …), and each has its own marker file, created atomically (`wx`): of several callers in one
 * window only the first succeeds. Nothing is ever read back or replaced, so no caller can mistake a marker
 * that another process is still writing, or has just replaced, for an expired one.
 *
 * @param params.file The marker file for this action; the window number is appended
 * @param params.windowMs How long one window lasts
 * @param params.now Current time, for tests
 */
export function claimWindow(params: { file: string; windowMs: number; now?: number }): boolean {
  const window = Math.floor((params.now ?? Date.now()) / params.windowMs);
  const dir = path.dirname(params.file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${params.file}.${window}`, '', { flag: 'wx' });
  } catch {
    return false; // another process claimed this window first (or the folder is not writable)
  }
  // Markers of earlier windows are never looked at again. The previous one is kept so a caller whose clock
  // reads a moment earlier still finds it.
  const prefix = `${path.basename(params.file)}.`;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(prefix) && Number(name.slice(prefix.length)) < window - 1) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // Clean-up only.
  }
  return true;
}
