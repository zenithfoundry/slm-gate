/**
 * @fileoverview What slm-gate's MCP server does when a coding tool starts it, and every minute after: checks
 * Ollama and the configured models, and keeps the model gate running. Nobody has to run a command. Problems
 * are logged, shown as a desktop notification and (at start-up) passed to the AI in the MCP server's
 * instructions; nothing is said when all is well. None of this can stop the MCP server from starting.
 */
import path from 'node:path';
import { CONFIG } from '../config.js';
import { checkLocalModels, ModelUse, SetupProblem } from './local-models.js';
import { cliCommand, GATE_LOG_FILE, isStoppedByUser, launchModelGate, probeGate, waitForModelGate } from './model-gate.js';
import { notifyUser } from './notify.js';

export interface Notice {
  /** A stable name for the problem, so notifications de-duplicate across sessions. */
  key: string;
  message: string;
  fix: string;
  /** Needs to be seen twice before it is reported. See SetupProblem.transient. */
  transient?: boolean;
}

// The coding tool is waiting for the MCP handshake: the checks before it get at most this long.
const FAST_CHECK_MS = 1500;
const WATCH_EVERY_MS = 60_000;
// The first watch check runs once a gate launched at start-up has had time to come up.
const FIRST_WATCH_MS = 15_000;

const port = () => CONFIG.MODEL_GATE_PORT;

function portTakenNotice(): Notice {
  return {
    key: 'port-taken',
    message: `Port ${port()} is used by another program, so the model gate cannot run there and coding tools pointed at http://localhost:${port()} cannot reach their AI provider.`,
    fix: `Quit that program (\`${cliCommand('doctor')}\` names it). Or set LLM_GATE_PORT to a free port in ${path.join(CONFIG.ROOT_DIR, '.env')}, run \`${cliCommand('restart')}\`, change the address in each coding tool (\`${cliCommand('doctor')}\` prints the lines) and restart them.`,
  };
}

function staleNotice(): Notice {
  return {
    key: 'gate-stale',
    message: `The model gate on port ${port()} is still running an older slm-gate build.`,
    fix: `Run \`${cliCommand('restart')}\` when no coding tool is in the middle of an answer.`,
  };
}

function notRunningNotice(): Notice {
  return {
    key: 'gate-not-running',
    message: `The model gate on port ${port()} is not running and did not start, so coding tools pointed at it cannot reach their AI provider.`,
    fix: `Run \`${cliCommand('start')}\`. If it still fails, see ${GATE_LOG_FILE} or run \`${cliCommand('doctor')}\`.`,
  };
}

function report(notice: Notice): void {
  console.error(`[slm-gate] ${notice.message} Fix: ${notice.fix}`);
  notifyUser({ key: notice.key, message: `${notice.message} ${notice.fix}` });
}

/**
 * What the gate probe means at start-up; launches the gate at once when nothing listens.
 * @returns The problems, and the models a running gate uses (checked along with this process's own)
 */
async function checkGateAtStartup(): Promise<{ notices: Notice[]; gateModels?: ModelUse[] }> {
  if (!CONFIG.LLM_GATE_AUTOSTART) return { notices: [] };
  const probe = await probeGate({ timeoutMs: 1000 });
  if (probe.kind === 'slm-gate') return { notices: probe.stale ? [staleNotice()] : [], gateModels: probe.health.models };
  if (probe.kind === 'other') return { notices: [portTakenNotice()] };
  // Nothing listens. Launch now, so the gate is booting before the coding tool's first model request;
  // whether it came up, and its models, are checked later by the watch.
  if (!isStoppedByUser()) launchModelGate();
  return { notices: [] };
}

function modelNotices(problems: SetupProblem[]): Notice[] {
  return problems.map(problem => ({ key: `models:${problem.fix}`, ...problem }));
}

/**
 * The start-up checks, capped at about 1.5 s. Late results are dropped (their promises are already
 * handled); a gate launch still happens when the probe answers late.
 *
 * @returns The problems to pass to the AI; each has also been logged and notified
 */
export async function runStartupChecks(): Promise<Notice[]> {
  const cap = new Promise<Notice[]>(resolve => setTimeout(() => resolve([]), FAST_CHECK_MS).unref());
  const gate = checkGateAtStartup().catch(() => ({ notices: [] as Notice[], gateModels: undefined }));
  // The probe answers in milliseconds, so the model check can wait for the running gate's models.
  const models = gate
    .then(result => checkLocalModels({ timeoutMs: FAST_CHECK_MS - 300, gateModels: result.gateModels }))
    // A check squeezed into the start-up budget, while the editor, the toolbox and often Ollama itself
    // are all still starting, is weak evidence. Anything that might be a timing artifact waits for the
    // watch, which gets a quiet moment and a second opinion. This matters more here than anywhere else:
    // the instructions handed to the editor are fixed for the whole session, so a wrong notice at
    // start-up is repeated by the AI until the session ends, long after the truth has changed.
    .then(result => modelNotices(result.problems).filter(notice => !notice.transient))
    .catch(() => [] as Notice[]);
  const notices = (await Promise.all([Promise.race([gate.then(result => result.notices), cap]), Promise.race([models, cap])])).flat();
  notices.forEach(report);
  return notices;
}

/**
 * While the MCP server lives: relaunch the gate if it died (unless you stopped it; at most once a minute
 * across all sessions) and re-check the local models. Problems are logged and notified.
 *
 * @param params.firstMs Delay before the first check (default 15 s)
 * @param params.everyMs Interval after that (default 60 s)
 * @returns Stops the watch (tests)
 */
export function watchModelGate(params: { firstMs?: number; everyMs?: number } = {}): () => void {
  if (!CONFIG.LLM_GATE_AUTOSTART) return () => {};
  // Transient problems reported by the previous check. One that is still there on the next check is
  // real; one that has gone was the machine being busy, and nobody ever hears about it.
  let awaitingConfirmation = new Set<string>();
  const check = async () => {
    const probe = await probeGate();
    let gate = probe.kind === 'slm-gate' ? probe.health : null;
    if (probe.kind === 'other') report(portTakenNotice());
    if (probe.kind === 'nothing' && !isStoppedByUser()) {
      const { launched } = launchModelGate();
      // Not launched = another session already launched it this minute. Give that one a moment, but stay
      // quiet if it is not up: the next check can launch again, and reports if that launch fails.
      gate = await waitForModelGate({ timeoutMs: launched ? 10_000 : 2_000 });
      if (!gate && launched) report(notRunningNotice());
    }
    const { problems } = await checkLocalModels({ gateModels: gate?.models });
    const notices = modelNotices(problems);
    notices.filter(notice => !notice.transient || awaitingConfirmation.has(notice.key)).forEach(report);
    awaitingConfirmation = new Set(notices.filter(notice => notice.transient).map(notice => notice.key));
  };
  const run = () => void check().catch(err => console.error(`[slm-gate] model gate check failed: ${err instanceof Error ? err.message : String(err)}`));

  let interval: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    run();
    interval = setInterval(run, params.everyMs ?? WATCH_EVERY_MS);
    interval.unref();
  }, params.firstMs ?? FIRST_WATCH_MS);
  first.unref();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
