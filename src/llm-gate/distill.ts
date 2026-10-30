/**
 * @fileoverview Step B of the model gate: distil the large command, search and listing tool results of
 * one request before it leaves the machine, and change nothing else.
 *
 * Byte stability is the point. Coding tools resend the whole history every turn, providers cache that
 * history, and Anthropic rejects a request whose earlier messages differ from what produced earlier
 * thinking. So each tool result is decided once per conversation — distilled text or original — and
 * that decision is resent from then on:
 *  - Only results the provider has never seen (the newest turn) are ever distilled. A history result
 *    with no stored decision was necessarily sent as the original, so it stays the original.
 *  - Distilled text is sent only after its decision is stored. If storing fails the original is sent,
 *    so "no stored decision" can only ever mean "the original was sent".
 *  - Past the time budget, or on any error, the original is the decision.
 *  - The decision key holds only what cannot change within a conversation (see decisionKey).
 * File reads are never distilled because edits need their exact text; that includes shell commands
 * that read files, which is how Codex reads them.
 */
import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { getDistillDecision, recordDistillDecision } from '../ledger/index.js';
import { log } from '../log.js';
import { compressNarrativeRun } from '../models/reasoning.js';
import { SLM } from '../models/slm.js';
import { distillToolResult, estimateTokens, rewriteElisionHint } from '../utils/elision.js';
import { buildPreserveList } from '../utils/preserve-patterns.js';
import { conversationKey, JsonObject, ToolResult, WireFormatModule } from './formats/contract.js';
import { track } from '../models/busy.js';

export type Kind = 'command' | 'search' | 'listing';

// Lowercased function names of the tools whose output is distilled. Anything else — file reads, web
// fetches, sub-agents, MCP tools, edits — passes unchanged.
const KIND_BY_TOOL = new Map<string, Kind>([
  ...['bash', 'run_shell_command', 'shell', 'exec_command', 'local_shell', 'execute_command', 'run_command'].map(name => [name, 'command'] as const),
  ...['grep', 'grep_search', 'search_file_content', 'search_files'].map(name => [name, 'search'] as const),
  ...['glob', 'list_directory', 'ls', 'list_files', 'list_dir', 'list'].map(name => [name, 'listing'] as const),
]);

// distillToolResult picks its rules by a substring of the tool name: these fire the log rule (errors
// with context plus the last 50 lines) and the top-50-lines rule. The real name follows a colon.
const ENGINE_RULE: Record<Kind, string> = { command: 'run_command', search: 'grep_search', listing: 'list_dir' };

const FILE_READERS = new Set(['cat', 'bat', 'less', 'more', 'head', 'tail', 'nl']);
// Words that run the program after them.
const COMMAND_PREFIXES = new Set(['env', 'sudo', 'command', 'exec', 'time', 'nice', 'xargs']);

/** Produces the distilled text for one tool result. The default runs distillToolResult; tests inject one. */
export type DistillEngine = (params: { text: string; toolName: string; callArgs: unknown; kind: Kind }) => Promise<string>;

export interface DistillStats {
  toolResults: number;
  candidates: number;
  distilled: number;
  reused: number;
  keptOriginal: number;
  timeouts: number;
  errors: number;
}

type Outcome = 'reused' | 'history' | 'distilled' | 'timeout' | 'error' | 'store_error' | 'read_error';

class DeadlineExceeded extends Error {}

let slm: SLM | undefined;
let preserveList: Promise<RegExp[]> | undefined;
const inFlight = new Map<string, Promise<string>>();

function parsedArgs(callArgs: unknown): any {
  if (typeof callArgs !== 'string') return callArgs;
  try {
    return JSON.parse(callArgs);
  } catch {
    return { command: callArgs };
  }
}

/** The shell command a command tool ran: `command` / `cmd` as a string or an argv array. */
export function commandOf(callArgs: unknown): string {
  const args = parsedArgs(callArgs);
  const command = args?.command ?? args?.cmd;
  if (Array.isArray(command)) return command.map(String).join(' ');
  return typeof command === 'string' ? command : '';
}

/**
 * True when any step of the command prints a file: cat, bat, less, more, head, tail, nl, or sed with
 * -n (also -ne, -En), after `bash -lc` / `sh -c` wrappers, `NAME=value` assignments and the prefixes
 * env, sudo, command, exec, time, nice, xargs. Pipes into head/tail count too, which keeps some
 * listings whole (the safe direction). Not detected, so still distilled: awk, python -c,
 * `git show rev:file`, `find -exec cat`.
 */
export function isFileReadCommand(command: string): boolean {
  return command.split(/&&|\|\||;|\|/).some(segment => {
    let words = segment.trim().split(/\s+/).map(word => word.replace(/^['"]+|['"]+$/g, '')).filter(Boolean);
    for (;;) {
      if (words.length > 2 && /^(?:ba|z)?sh$/.test(words[0]) && /^-\w*c$/.test(words[1])) words = words.slice(2);
      else if (words.length > 1 && /^[A-Za-z_]\w*=/.test(words[0])) words = words.slice(1);
      else break;
    }
    // A prefix may carry its own flags and values before the real program (`nice -n 10 cat`,
    // `xargs -I {} cat {}`), so any reader word after it counts — the safe direction.
    const programs = COMMAND_PREFIXES.has(words[0]) ? words.slice(1) : words.slice(0, 1);
    return programs.some(word => {
      const program = word.split('/').pop() ?? '';
      return FILE_READERS.has(program) || (program === 'sed' && words.some(flag => /^-[A-Za-z]*n[A-Za-z]*$/.test(flag)));
    });
  });
}

function distillableKind(result: ToolResult<unknown>): Kind | null {
  const kind = KIND_BY_TOOL.get(result.toolName.toLowerCase());
  if (!kind) return null;
  if (kind === 'command' && isFileReadCommand(commandOf(result.callArgs))) return null;
  return kind;
}

/**
 * The key a distillation decision is stored under: the conversation (its first user entry, which never
 * changes while the conversation lasts) plus only what cannot change for a result within it. Two sessions
 * that meet the same tool output must not share a decision, since one may already have sent the original.
 * Engine version, prompt version and marker wording are deliberately left out: a changed key would find no
 * decision for history the provider has already seen distilled.
 */
function decisionKey(params: { conversation: string; result: ToolResult<unknown> }): string {
  const { conversation, result } = params;
  return crypto.createHash('sha256').update(conversation).update('\0').update(result.toolName).update('\0').update(result.text).digest('hex');
}

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .flatMap((tool: any) => [tool?.name, tool?.function?.name, ...(Array.isArray(tool?.functionDeclarations) ? tool.functionDeclarations.map((f: any) => f?.name) : [])])
    .filter((name): name is string => typeof name === 'string');
}

const defaultEngine: DistillEngine = async ({ text, toolName, callArgs, kind }) => {
  const client = (slm ??= new SLM());
  preserveList ??= buildPreserveList();
  const compress = (run: string, task?: string) => compressNarrativeRun({ slm: client, text: run, task });
  // An empty task keeps the engine's own cache key the same on every turn.
  return distillToolResult({ slm: compress, text, task: '', toolName: `${ENGINE_RULE[kind]}:${toolName}`, args: callArgs, preservePatterns: await preserveList });
};

/** One distillation per key at a time: a retried request joins the one already running. */
function distilOnce(key: string, run: () => Promise<string>): Promise<string> {
  let pending = inFlight.get(key);
  if (!pending) {
    pending = run();
    inFlight.set(key, pending);
    const forget = () => { inFlight.delete(key); };
    pending.then(forget, forget);
  }
  return pending;
}

function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded()), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/** Stores a decision and returns the text to send; distilled text is only sent once its decision is on disk. */
function persistThenSend(params: { key: string; original: string; text: string; outcome: Outcome }): { text: string; stored: boolean } {
  const { key, original, text, outcome } = params;
  try {
    return { text: recordDistillDecision({ key, text, outcome }).text, stored: true };
  } catch (err) {
    log.warn('llm-gate', 'distill decision not stored; sending the original', { error: err });
    return { text: original, stored: false };
  }
}

async function decide(params: {
  result: ToolResult<unknown>;
  kind: Kind;
  conversation: string;
  deadline: number;
  engine: DistillEngine;
  expandHint: boolean;
}): Promise<{ text: string; outcome: Outcome }> {
  const { result, kind, conversation, deadline, engine, expandHint } = params;
  const key = decisionKey({ conversation, result });

  let stored: ReturnType<typeof getDistillDecision>;
  try {
    stored = getDistillDecision(key);
  } catch (err) {
    // Unknown whether a decision exists: send the original, record nothing.
    log.warn('llm-gate', 'distill decision not readable; sending the original', { error: err });
    return { text: result.text, outcome: 'read_error' };
  }
  if (stored) return { text: stored.text, outcome: 'reused' };

  if (!result.newTurn) {
    // The provider has already seen this text and no decision exists, so what it saw was the original.
    const sent = persistThenSend({ key, original: result.text, text: result.text, outcome: 'history' });
    return { text: sent.text, outcome: sent.stored ? 'history' : 'store_error' };
  }

  let text = result.text;
  let outcome: Outcome = 'distilled';
  try {
    const distilled = await beforeDeadline(
      // Counted as a running local call so the memory fold waits for it (src/models/busy.ts).
      distilOnce(key, () => track(engine({ text: result.text, toolName: result.toolName, callArgs: result.callArgs, kind }))),
      deadline,
    );
    text = expandHint ? distilled : rewriteElisionHint(distilled);
  } catch (err) {
    outcome = err instanceof DeadlineExceeded ? 'timeout' : 'error';
    if (outcome === 'error') log.warn('llm-gate', 'distillation failed, sending the original', { error: err });
  }
  const sent = persistThenSend({ key, original: result.text, text, outcome });
  return { text: sent.text, outcome: sent.stored ? outcome : 'store_error' };
}

/**
 * Distils the new large command, search and listing results of one request and resends every earlier
 * decision unchanged.
 *
 * @param params.format The request's wire-format module
 * @param params.body The parsed request body (not modified)
 * @param params.engine Produces distilled text; defaults to distillToolResult with the local model
 * @returns The body to send, or null when nothing changed, and what happened
 */
export async function distilRequest(params: {
  format: WireFormatModule;
  body: JsonObject;
  engine?: DistillEngine;
}): Promise<{ body: JsonObject | null; stats: DistillStats }> {
  const { format, body, engine = defaultEngine } = params;
  const results = format.listToolResults(body);
  const candidates = results.flatMap(result => {
    const kind = distillableKind(result);
    return kind && estimateTokens(result.text) >= CONFIG.DISTILL_MIN_TOKENS ? [{ result, kind }] : [];
  });
  const stats: DistillStats = { toolResults: results.length, candidates: candidates.length, distilled: 0, reused: 0, keptOriginal: 0, timeouts: 0, errors: 0 };
  if (candidates.length === 0) return { body: null, stats };

  const conversation = conversationKey(body);
  const expandHint = toolNames(body.tools).some(name => name.endsWith('expand_elision'));
  const deadline = Date.now() + CONFIG.DISTILL_BUDGET_MS;
  const decisions = await Promise.all(candidates.map(({ result, kind }) => decide({ result, kind, conversation, deadline, engine, expandHint })));

  let sendBody = body;
  decisions.forEach((decision, i) => {
    const { result } = candidates[i];
    const changed = decision.text !== result.text;
    if (decision.outcome === 'timeout') stats.timeouts++;
    else if (decision.outcome === 'error') stats.errors++;
    if (!changed) stats.keptOriginal++;
    else if (decision.outcome === 'reused') stats.reused++;
    else stats.distilled++;
    if (changed) sendBody = format.replaceToolResultText({ body: sendBody, location: result.location, text: decision.text });
  });
  return { body: sendBody === body ? null : sendBody, stats };
}

/** Loads the local model in the background so the first distillation does not pay the ~9 s cold start. */
export function warmUpLocalModel(): void {
  slm ??= new SLM();
  slm.generateText({ model: CONFIG.SLM_GATE_MODEL, messages: [{ role: 'user', content: 'ok' }], temperature: 0, maxTokens: 1 }).catch(() => {
    // Ollama down or model missing: each distillation then falls back to the original on its own.
  });
}
