/**
 * @fileoverview What slm-gate's MCP server does when a coding tool starts it, and every minute after: checks
 * Ollama and the configured models, and keeps the model gate running. Nobody has to run a command. Problems
 * are logged, shown as a desktop notification and (at start-up) passed to the AI in the MCP server's
 * instructions; nothing is said when all is well. None of this can stop the MCP server from starting.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { log } from '../log.js';
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
    fix: `Quit that program (\`${cliCommand('doctor')}\` names it). Or set LLM_GATE_PORT to a free port in ${path.join(CONFIG.HOME_DIR, '.env')}, run \`${cliCommand('restart')}\`, change the address in each coding tool (\`${cliCommand('doctor')}\` prints the lines) and restart them.`,
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

/** slm-gate's own settings file: the only settings the shared model gate reads (src/setup/model-gate.ts). */
const settingsFile = () => path.join(CONFIG.HOME_DIR, '.env');

/**
 * Checked on every run, not once, so the notice stops as soon as `init` has created the file. While the
 * file is missing the gate runs on built-in defaults, which need not be models anybody downloaded, and
 * a coding tool's MCP env block cannot change that: the gate is shared, so it ignores every tool's block.
 */
function hasSettingsFile(): boolean {
  return fs.existsSync(settingsFile());
}

function noSettingsNotice(): Notice {
  // A shell the fix is pasted into lacks the coding tool's SLM_GATE_HOME, so init would write elsewhere.
  const home = process.env.SLM_GATE_HOME ? `SLM_GATE_HOME=${CONFIG.HOME_DIR} ` : '';
  return {
    key: 'settings-missing',
    message: `slm-gate has no settings file (${settingsFile()}), so the model gate, which every coding tool shares, runs on built-in default models. It never reads a coding tool's own "env" settings.`,
    fix: `Run \`${home}${cliCommand('init')}\`, then the \`ollama pull …\` line it prints, then \`${home}${cliCommand('restart')}\`. Put model settings in that file, not in a coding tool's settings.`,
  };
}

function report(notice: Notice): void {
  log.warn('slm-gate', `${notice.message} Fix: ${notice.fix}`);
  notifyUser({ key: notice.key, message: `${notice.message} ${notice.fix}` });
}

/**
 * What the gate probe means at start-up; launches the gate at once when nothing listens.
 * @returns The problems, and the models a running gate uses (checked along with this process's own). Without
 *   a settings file the gate's models are not checked: they are built-in defaults, so the one problem to
 *   report is the missing file, not a model nobody chose.
 */
async function checkGateAtStartup(): Promise<{ notices: Notice[]; gateModels?: ModelUse[] }> {
  if (!CONFIG.LLM_GATE_AUTOSTART) return { notices: [] };
  const probe = await probeGate({ timeoutMs: 1000 });
  if (probe.kind === 'other') return { notices: [portTakenNotice()] };
  const settings = hasSettingsFile() ? [] : [noSettingsNotice()];
  if (probe.kind === 'slm-gate') {
    return { notices: [...settings, ...(probe.stale ? [staleNotice()] : [])], gateModels: settings.length ? undefined : probe.health.models };
  }
  // Nothing listens. Launch now, so the gate is booting before the coding tool's first model request;
  // whether it came up, and its models, are checked later by the watch.
  if (!isStoppedByUser()) launchModelGate();
  return { notices: settings };
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
    const settingsFound = hasSettingsFile();
    if (!settingsFound) report(noSettingsNotice());
    const { problems } = await checkLocalModels({ gateModels: settingsFound ? gate?.models : undefined });
    const notices = modelNotices(problems);
    notices.filter(notice => !notice.transient || awaitingConfirmation.has(notice.key)).forEach(report);
    awaitingConfirmation = new Set(notices.filter(notice => notice.transient).map(notice => notice.key));
  };
  const run = () => void check().catch(err => log.error('slm-gate', 'model gate check failed', { error: err }));

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
