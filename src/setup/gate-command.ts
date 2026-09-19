/**
 * @fileoverview `slm-gate start | stop | restart` — recovery commands for the model gate. Day to day it
 * starts by itself whenever a coding tool starts slm-gate's MCP server; these are for when you want to
 * control it by hand (`stop` keeps it stopped until `start`, `restart` or a reboot).
 */
import { CONFIG } from '../config.js';
import { cliCommand, GATE_LOG_FILE, startModelGate, stopModelGate } from './model-gate.js';

const address = `http://localhost:${CONFIG.MODEL_GATE_PORT}`;

async function main(action: string): Promise<void> {
  if (!['start', 'stop', 'restart'].includes(action)) {
    console.error(`Unknown action "${action}": use start, stop or restart.`);
    process.exitCode = 1;
    return;
  }

  if (action === 'stop' || action === 'restart') {
    const stopped = await stopModelGate();
    console.log(stopped ? `Stopped the model gate on ${address} (pid ${stopped.pid}).` : `No model gate was running on ${address}.`);
    if (action === 'stop') {
      console.log(`It stays stopped until \`${cliCommand('start')}\`, \`${cliCommand('restart')}\` or a reboot. Coding tools pointed at it cannot reach their AI provider meanwhile.`);
      return;
    }
  }

  const probe = await startModelGate();
  if (probe.kind === 'slm-gate') {
    console.log(`The model gate is running on ${address} (pid ${probe.health.pid}).`);
    if (probe.stale) console.log(`It is an older slm-gate build: run \`${cliCommand('restart')}\` when no coding tool is in the middle of an answer.`);
  } else if (probe.kind === 'other') {
    console.error(`Port ${CONFIG.MODEL_GATE_PORT} is used by another program, so the model gate cannot start there. Run \`${cliCommand('doctor')}\` to see which program and how to change the port.`);
    process.exitCode = 1;
  } else {
    console.error(`The model gate did not start. See ${GATE_LOG_FILE}, or run \`${cliCommand('doctor')}\`.`);
    process.exitCode = 1;
  }
}

main(process.argv[2] ?? 'start').catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
