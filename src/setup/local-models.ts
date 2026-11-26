/**
 * @fileoverview Are the local models slm-gate is configured to use actually there? Used by `slm-gate doctor`
 * and by the MCP server's start-up check. It only reports, each problem with its exact fix; it never starts
 * Ollama or downloads a model.
 */
import { CONFIG } from '../config.js';
import { howToStartOllama } from './ollama-install.js';
import { modelsFor, type ModelUse } from './required-models.js';

export type { ModelUse };

export interface SetupProblem {
  message: string;
  fix: string;
  /**
   * True when this might be a timing artifact rather than a real fault, so it has to be seen twice
   * before anybody is told. Giving up waiting is the only such case: every other answer here — a
   * refused connection, an address that is not a URL, a reply from something that is not Ollama, a
   * model missing from disk — is a fact that does not depend on how busy the machine was.
   */
  transient?: boolean;
}

/** The models this process's settings use, and what each one is for. */
export function requiredModels(): ModelUse[] {
  return modelsFor(CONFIG);
}

/** Ollama lists `name:tag`; a setting without a tag means `:latest`. */
function isPulled(name: string, pulled: string[]): boolean {
  return pulled.includes(name) || (!name.includes(':') && pulled.includes(`${name}:latest`));
}

/**
 * What asking Ollama for its model list produced. These need different fixes, so they are different
 * answers: telling somebody to start Ollama when it is already running and merely slow sends them to
 * `ollama serve`, which then fails with "address already in use" and explains nothing.
 */
export type OllamaProbe =
  | { kind: 'ok'; pulled: string[] }
  /** Nothing accepted the connection: Ollama really is not running (or not at this address). */
  | { kind: 'unreachable'; detail: string }
  /** We gave up before Ollama answered. Says nothing about whether it is running. */
  | { kind: 'no-answer'; detail: string }
  /** OLLAMA_HOST is not a URL we can fetch, so no request was ever made. */
  | { kind: 'bad-host'; detail: string }
  /** Something answered, but not the way Ollama answers. */
  | { kind: 'not-ollama'; detail: string };

/** Connection failures that mean nothing is listening, as opposed to a slow or wrong answer. */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET']);

/** fetch reports the underlying error as `cause`, or as an AggregateError when it tried IPv6 and IPv4. */
function causeCodes(err: unknown): string[] {
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof AggregateError) return cause.errors.map(one => (one as NodeJS.ErrnoException)?.code ?? '');
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code ? [code] : [];
}

/**
 * Asks Ollama what it has downloaded, and distinguishes the ways that can fail.
 *
 * @param params.timeoutMs How long to wait for an answer (default 3000)
 */
export async function probeOllama(params: { timeoutMs?: number } = {}): Promise<OllamaProbe> {
  const timeoutMs = params.timeoutMs ?? 3000;
  const host = CONFIG.OLLAMA_HOST;
  let url: URL;
  try {
    // Keep any path prefix in OLLAMA_HOST (a reverse proxy may serve Ollama under one).
    url = new URL(`${host.replace(/\/+$/, '')}/api/tags`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`scheme ${url.protocol}`);
  } catch {
    return { kind: 'bad-host', detail: host };
  }

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // A timeout here can be self-inflicted: an AbortSignal armed before a busy stretch fires as soon as
    // the event loop frees, sometimes before the request touches the network. Never read it as "down".
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { kind: 'no-answer', detail: `no answer within ${timeoutMs} ms` };
    }
    const codes = causeCodes(err);
    if (codes.some(code => UNREACHABLE.has(code))) return { kind: 'unreachable', detail: codes.join(', ') };
    return { kind: 'no-answer', detail: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) return { kind: 'not-ollama', detail: `answered ${res.status}` };
  try {
    const data = await res.json() as { models?: { name: string }[] | null };
    if (!Array.isArray(data.models)) return { kind: 'not-ollama', detail: 'answered without a model list' };
    return { kind: 'ok', pulled: data.models.map(model => model.name) };
  } catch {
    return { kind: 'not-ollama', detail: 'answered with something that is not JSON' };
  }
}

/** The one problem to report when Ollama's model list could not be read. */
function probeProblem(probe: Exclude<OllamaProbe, { kind: 'ok' }>): SetupProblem {
  const host = CONFIG.OLLAMA_HOST;
  switch (probe.kind) {
    case 'unreachable':
      return {
        message: `Ollama is not running at ${host}, so nothing is shrunk or remembered locally (requests still reach the cloud).`,
        fix: howToStartOllama(),
      };
    case 'no-answer':
      return {
        message: `Ollama did not answer at ${host} (${probe.detail}), so slm-gate could not check the local models. This does not mean Ollama is down.`,
        fix: 'Usually nothing: it is often just busy while everything starts. If it keeps happening, run `slm-gate doctor`.',
        transient: true,
      };
    case 'bad-host':
      return {
        message: `OLLAMA_HOST is "${probe.detail}", which is not an http address, so slm-gate never asked Ollama anything.`,
        fix: 'Set OLLAMA_HOST to a full URL, e.g. http://localhost:11434. Ollama\'s own OLLAMA_HOST variable is a bare host:port, but slm-gate needs the http:// in front.',
      };
    case 'not-ollama':
      return {
        message: `Something is listening at ${host} but it is not Ollama (${probe.detail}).`,
        fix: 'Point OLLAMA_HOST at the address Ollama is really on, or stop the other program. `slm-gate doctor` names what holds the port.',
      };
  }
}

/**
 * A model setting from the environment overrides slm-gate's .env, so editing .env does not stop this problem.
 * For the MCP server that environment is a coding tool's "env" settings for the project it was started in,
 * so the message names that project: it is the only clue to which file to change.
 */
function missingModelProblem(model: ModelUse): SetupProblem {
  const usage = `${model.name} (${model.setting}, used for ${model.purpose})`;
  if (!CONFIG.SET_IN_ENVIRONMENT.includes(model.setting)) {
    return { message: `The local model ${usage} is not downloaded.`, fix: `ollama pull ${model.name}` };
  }
  return {
    message: `slm-gate started in ${process.cwd()} uses the local model ${usage}, which is not downloaded. ${model.setting} is set in the "env" settings it was started with (often that project's .mcp.json), which override slm-gate's .env.`,
    fix: `Delete ${model.setting} from those "env" settings and reconnect slm-gate, so slm-gate's .env picks the model. Or run ollama pull ${model.name}.`,
  };
}

/**
 * @param params.timeoutMs How long to wait for Ollama (default 3000)
 * @param params.gateModels The models the running model gate uses (from its health answer). The gate reads
 *   only slm-gate's .env, which can name other models than the MCP env block this process was started with.
 *   A process whose own SLM_PROVIDER is not ollama checks nothing (its OLLAMA_HOST then points elsewhere);
 *   sessions on Ollama and `slm-gate doctor`, which reads the same .env as the gate, still check them.
 * @returns The problems found (empty when all is well) and the models Ollama has
 */
export async function checkLocalModels(params: { timeoutMs?: number; gateModels?: readonly ModelUse[] } = {}): Promise<{ problems: SetupProblem[]; pulled: string[] }> {
  if (CONFIG.SLM_PROVIDER !== 'ollama') return { problems: [], pulled: [] };

  const probe = await probeOllama({ timeoutMs: params.timeoutMs });
  if (probe.kind !== 'ok') return { problems: [probeProblem(probe)], pulled: [] };
  const pulled = probe.pulled;

  const gateModels = (params.gateModels ?? []).map(model => ({ ...model, setting: `${model.setting} in slm-gate's .env` }));
  const problems = [...requiredModels(), ...gateModels]
    .filter((model, index, all) => all.findIndex(other => other.name === model.name) === index) // two settings, one model
    .filter(model => !isPulled(model.name, pulled))
    .map(missingModelProblem);
  return { problems, pulled };
}
