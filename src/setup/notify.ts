/**
 * @fileoverview Desktop notifications for slm-gate problems (macOS; Linux when notify-send exists; nothing
 * on other systems — the log line and the notice to the AI still carry the message). Each message is shown
 * at most once per 10 minutes across every running slm-gate process, so ten IDE windows opening together
 * give one pop-up, not ten.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { claimWindow } from './claim.js';

const REPEAT_AFTER_MS = 10 * 60 * 1000;

/** True for exactly one caller per problem per 10 minutes, across processes. */
export function claimNotice(params: { key: string; dir?: string; now?: number }): boolean {
  const dir = params.dir ?? path.join(CONFIG.OUTPUT_DIR, '.notices');
  const file = path.join(dir, crypto.createHash('sha256').update(params.key).digest('hex').slice(0, 16));
  return claimWindow({ file, windowMs: REPEAT_AFTER_MS, now: params.now });
}

/**
 * Shows a desktop notification, unless the same problem was already shown in this 10-minute window.
 *
 * @param params.key A stable name for the problem (e.g. 'gate-launch-failed'), so two sessions describing
 *   the same failure in slightly different words still show one pop-up
 */
export function notifyUser(params: { key: string; message: string; title?: string }): void {
  const title = params.title ?? 'slm-gate';
  let command: [string, string[]] | null = null;
  if (process.platform === 'darwin') {
    // JSON string literals are valid AppleScript string literals (same quote and backslash escapes).
    command = ['osascript', ['-e', `display notification ${JSON.stringify(params.message)} with title ${JSON.stringify(title)}`]];
  } else if (process.platform === 'linux') {
    command = ['notify-send', [title, params.message]];
  }
  if (!command || !claimNotice({ key: params.key })) return;
  try {
    const child = spawn(command[0], command[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // e.g. notify-send not installed: the log line still has the message
    child.unref();
  } catch {
    // Same: never let a notification problem affect slm-gate itself.
  }
}
