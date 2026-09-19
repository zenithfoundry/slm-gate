/**
 * @fileoverview Keeps the model gate (the HTTP server on LLM_GATE_PORT that coding tools send every model
 * request to) running without anyone starting it by hand. slm-gate's MCP server — which every coding tool
 * starts on its own — probes it at start-up and every minute, and launches it in the background when
 * nothing is listening. Several MCP servers run at once (one per IDE window / CLI session); they agree
 * through two marker files: a shared launch cooldown, and a "stopped by you" marker from `slm-gate stop`.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, CONFIG_ENV_KEYS } from '../config.js';
import { claimWindow } from './claim.js';
import type { ModelUse } from './local-models.js';

/** Answered by the gate itself, never forwarded (src/llm-gate/server.ts). */
export const HEALTH_PATH = '/slm-gate/health';

export interface GateHealth {
  service: 'slm-gate';
  pid: number;
  port: number;
  /** The gate's server file, and its modification time when the gate started. */
  entry: string;
  build: string;
  startedAt: string;
  /** The local models the gate's own settings use (absent from gates started before this was added). */
  models?: ModelUse[];
}

export type GateProbe =
  | { kind: 'slm-gate'; health: GateHealth; stale: boolean }
  | { kind: 'nothing' }
  | { kind: 'other' };

export const GATE_LOG_FILE = path.join(CONFIG.OUTPUT_DIR, 'llm-gate.log');
const STOPPED_MARKER = path.join(CONFIG.OUTPUT_DIR, '.gate-stopped');
const LAUNCH_MARKER = path.join(CONFIG.OUTPUT_DIR, '.gate-launch');
const LAUNCH_COOLDOWN_MS = 60_000;

/**
 * The command for an slm-gate CLI action on this install, e.g. `node /path/dist/cli.js restart`. Messages
 * print this rather than `slm-gate restart`, which only works once the command has been linked onto the PATH.
 */
export function cliCommand(action: string): string {
  const cli = path.join(CONFIG.ROOT_DIR, 'dist', 'cli.js');
  return `node ${cli.includes(' ') ? JSON.stringify(cli) : cli} ${action}`;
}

/** A newer slm-gate build is installed than the one the running gate was started from. */
function isStale(health: GateHealth): boolean {
  try {
    return String(Math.round(fs.statSync(health.entry).mtimeMs)) !== health.build;
  } catch {
    return false;
  }
}

/**
 * Asks whatever listens on the port who it is. Nothing listening is known at once (connection refused);
 * anything that is not the gate — another program, or one that does not answer in time — is 'other'.
 */
export function probeGate(params: { port?: number; timeoutMs?: number } = {}): Promise<GateProbe> {
  const port = params.port ?? CONFIG.MODEL_GATE_PORT;
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: HEALTH_PATH, timeout: params.timeoutMs ?? 1000 }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString('utf8')) as GateHealth;
          resolve(res.statusCode === 200 && health.service === 'slm-gate' ? { kind: 'slm-gate', health, stale: isStale(health) } : { kind: 'other' });
        } catch {
          resolve({ kind: 'other' });
        }
      });
      res.on('error', () => resolve({ kind: 'other' }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', err => resolve((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? { kind: 'nothing' } : { kind: 'other' }));
  });
}

/** Minutes since the epoch at which this machine booted: a new value means a reboot. */
function bootMinute(): number {
  return Math.round((Date.now() - os.uptime() * 1000) / 60_000);
}

/** `slm-gate stop` was run since the last boot, and no `slm-gate start` since. */
export function isStoppedByUser(): boolean {
  try {
    const stoppedAtBoot = Number(fs.readFileSync(STOPPED_MARKER, 'utf8'));
    // Allow a minute of drift in the computed boot time.
    return Math.abs(stoppedAtBoot - bootMinute()) <= 1;
  } catch {
    return false;
  }
}

function setStoppedByUser(stopped: boolean): void {
  if (stopped) {
    fs.mkdirSync(path.dirname(STOPPED_MARKER), { recursive: true });
    fs.writeFileSync(STOPPED_MARKER, String(bootMinute()));
  } else {
    fs.rmSync(STOPPED_MARKER, { force: true });
  }
}

/** The gate's entry file in this install, next to this module (built `.js` or source `.ts`). */
function gateEntry(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), '..', 'llm-gate', `index${path.extname(here)}`);
}

/**
 * The environment the gate is launched with: this process's, minus every variable slm-gate's config
 * reads, so the one shared gate takes its settings only from slm-gate's own .env — never from the MCP env
 * block of whichever coding tool started it first.
 */
export function gateEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CONFIG_ENV_KEYS.includes(name)));
}

/**
 * Starts the gate in the background and returns at once, unless another session already launched it this
 * minute (so a crash-looping gate is relaunched at most once a minute, however many windows are open).
 *
 * @param params.port Port to start it on (default LLM_GATE_PORT from slm-gate's .env)
 * @param params.envOverrides Extra variables after the clean-up (tests use it for a throwaway ledger)
 * @param params.execArgv Node flags for the child (default this process's, e.g. `--import tsx` from source)
 * @param params.ignoreCooldown For `slm-gate start` / `restart`, which the person asked for explicitly
 */
export function launchModelGate(params: {
  port?: number;
  envOverrides?: Record<string, string>;
  execArgv?: string[];
  ignoreCooldown?: boolean;
} = {}): { launched: boolean; reason?: string } {
  if (!params.ignoreCooldown && !claimWindow({ file: LAUNCH_MARKER, windowMs: LAUNCH_COOLDOWN_MS })) {
    return { launched: false, reason: 'another slm-gate session already launched it this minute' };
  }
  fs.mkdirSync(path.dirname(GATE_LOG_FILE), { recursive: true });
  const log = fs.openSync(GATE_LOG_FILE, 'a');
  try {
    const child = spawn(process.execPath, [...(params.execArgv ?? process.execArgv), gateEntry()], {
      cwd: CONFIG.ROOT_DIR,
      env: { ...gateEnvironment(), LLM_GATE_PORT: String(params.port ?? CONFIG.MODEL_GATE_PORT), ...params.envOverrides },
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', err => fs.appendFileSync(GATE_LOG_FILE, `[slm-gate] could not start the model gate: ${err.message}\n`));
    child.unref();
    return { launched: true };
  } finally {
    fs.closeSync(log);
  }
}

/** Waits until the gate answers its health check; null when it does not within the time. */
export async function waitForModelGate(params: { port?: number; timeoutMs?: number } = {}): Promise<GateHealth | null> {
  const deadline = Date.now() + (params.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const probe = await probeGate({ port: params.port, timeoutMs: 500 });
    if (probe.kind === 'slm-gate') return probe.health;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

/** The last lines of the gate's log, for a failure message. */
export function gateLogTail(lines = 5): string {
  try {
    return fs.readFileSync(GATE_LOG_FILE, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Which program listens on the port (macOS/Linux, via lsof), e.g. "node (pid 123)"; null when unknown. */
export function portOwner(port: number = CONFIG.MODEL_GATE_PORT): string | null {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', timeout: 2000 });
    const pid = /^p(\d+)/m.exec(out)?.[1];
    const command = /^c(.+)$/m.exec(out)?.[1];
    return pid ? `${command ?? 'a program'} (pid ${pid})` : null;
  } catch {
    return null;
  }
}

/** `slm-gate start`: clears "stopped by you" and launches the gate unless it already runs. */
export async function startModelGate(params: { port?: number } = {}): Promise<GateProbe> {
  setStoppedByUser(false);
  const probe = await probeGate({ port: params.port });
  if (probe.kind !== 'nothing') return probe;
  launchModelGate({ port: params.port, ignoreCooldown: true });
  const health = await waitForModelGate({ port: params.port });
  return health ? { kind: 'slm-gate', health, stale: false } : { kind: 'nothing' };
}

/** `slm-gate stop`: stops the gate and keeps it stopped until `slm-gate start`/`restart` or a reboot. */
export async function stopModelGate(params: { port?: number } = {}): Promise<GateHealth | null> {
  setStoppedByUser(true);
  const probe = await probeGate({ port: params.port });
  if (probe.kind !== 'slm-gate') return null;
  try {
    process.kill(probe.health.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await probeGate({ port: params.port, timeoutMs: 300 })).kind === 'slm-gate') {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return probe.health;
}
