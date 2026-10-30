/**
 * @fileoverview Whether the dashboard reads the history the running model gate writes.
 *
 * The dashboard runs from a git checkout and reads that install's ledger. When the coding tools run the npm
 * install instead, the gate writes to ~/.slm-gate/output, and the dashboard's numbers silently stop on the day
 * of the switch. The gate names its ledger in its health answer, so the two can be compared.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { probeGate } from '../setup/model-gate.js';

/** The same file however it is spelled (relative, through a symlink); a file not created yet is compared by path. */
function sameFile(a: string, b: string): boolean {
  const real = (file: string) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return real(a) === real(b);
}

/**
 * @returns The ledger the running gate writes, when it is not the one this dashboard reads (CONFIG.LEDGER_PATH).
 *   Null when they match, when no gate runs, or when the gate is too old to say.
 */
export async function otherGateLedger(): Promise<string | null> {
  const probe = await probeGate();
  if (probe.kind !== 'slm-gate' || !probe.health.ledger) return null;
  return sameFile(probe.health.ledger, CONFIG.LEDGER_PATH) ? null : probe.health.ledger;
}

export function otherLedgerMessage(gateLedger: string): string {
  return `The model gate on port ${CONFIG.MODEL_GATE_PORT} writes your requests to ${gateLedger}, but this dashboard reads ${CONFIG.LEDGER_PATH}, so its numbers miss them. ` +
    `Put LEDGER_PATH=${gateLedger} in front of the command. For the daily publish job, add LEDGER_PATH to its launchd agent: see "Keeping the published dashboard current" in docs/reference/analytics.md.`;
}
