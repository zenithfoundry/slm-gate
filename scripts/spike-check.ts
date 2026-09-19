/**
 * @fileoverview Slice 0 checks: runs each coding tool through the pass-through spike
 * (scripts/spike-passthrough.ts) and verifies, from the spike's log, that the tool's model requests
 * reached it, that a tool step (a request carrying a tool result) went through, and which login
 * the tool used.
 *
 * Every tool gets the same prompt, which makes it read ./package.json and reply with the name
 * field, so a passing check proves a full multi-step exchange and a correct answer.
 *
 * Usage:
 *   pnpm exec tsx scripts/spike-check.ts --list          list every check
 *   pnpm exec tsx scripts/spike-check.ts                 run every automatic check
 *   pnpm exec tsx scripts/spike-check.ts --manual        run every manual check
 *   pnpm exec tsx scripts/spike-check.ts <id> [<id>...]  run the named checks (manual ones included)
 *   add --gate to any of these                           run through the real llm-gate instead
 *
 * With --gate the checks are judged from the gate's ledger rows (written to a throwaway ledger, with
 * Langfuse off). Those rows carry path and status but not the login or the tool results, so --gate
 * requires at least two successful model requests instead; the spike run checks login and tool steps.
 *
 * An automatic check is SKIPPED, not failed, when its tool is not installed or a key it needs is
 * not set. A manual check (IDE extensions) prints the setting to use, waits while you send the
 * prompt from the IDE, then verifies the log. SPIKE_PORT picks the port (default 8799).
 */
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_PATH = path.join(ROOT, 'output', 'spike', 'requests.jsonl');
const PORT = Number(process.env.SPIKE_PORT || 8799);
const BASE_URL = `http://localhost:${PORT}`;
const TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const THROUGH_GATE = process.argv.includes('--gate');
const GATE_LEDGER = path.join(os.tmpdir(), `slm-gate-spike-check-${process.pid}.sqlite`);

const PROMPT = 'Use your file-reading tool to read ./package.json, then reply with only the value of its "name" field.';
const EXPECTED_ANSWER: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;

/** Credential kinds as the spike logs them (see credentialShape there); 'any' = present, kind unchecked. */
type Credential = 'anthropic-oauth' | 'anthropic-api-key' | 'jwt' | 'sk-key' | 'google-api-key' | 'any';

interface Expectation {
  id: string;
  title: string;
  /** Path prefix of this tool's model requests, e.g. '/v1/messages'. */
  pathPrefix: string;
  credential: Credential;
  /** False for tools that take files on the command line instead of through a tool call (Aider). */
  toolStep?: boolean;
  /**
   * A Step B check (runs only with --gate): at least one request must go out distilled, and no request
   * may be rejected with 400 (Anthropic's answer to changed history under earlier thinking).
   */
  distillCheck?: boolean;
}

interface AutoCheck extends Expectation {
  kind: 'auto';
  /** Returns the executable to run, or null when the tool is not installed. */
  findBinary: () => string | null;
  args: string[];
  /** Environment changes for the tool. `undefined` removes a variable. */
  env: Record<string, string | undefined>;
  /** Variables that must already be set (keys); the check is skipped without them. */
  requiredEnv?: string[];
  /** Why the check must not run on this machine (e.g. the tool is on an account login), or null. */
  skipReason?: () => string | null;
  /** An extra check on the tool's own output; returns what is wrong, or null. */
  outputCheck?: (output: string) => string | null;
}

interface ManualCheck extends Expectation {
  kind: 'manual';
  steps: string[];
}

type Check = AutoCheck | ManualCheck;

interface LogEntry {
  path: string;
  status?: number;
  /** Ledger route (gate only): forward_compressed when the request went out distilled. */
  route?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: { types?: Record<string, number>; roles?: Record<string, number>; keys?: Record<string, number> };
  response?: { status?: number; errorSample?: string };
  loginSignals?: Record<string, unknown>;
  clientAborted?: boolean;
}

interface Outcome {
  result: 'PASS' | 'FAIL' | 'SKIP';
  notes: string[];
}

/** Like `which`: the first executable file of that name on PATH. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing or not executable: keep looking, as `which` does.
    }
  }
  return null;
}

/** Claude Code on PATH, else the binary bundled with the newest installed VS Code extension. */
function findClaude(): string | null {
  const onPathClaude = onPath('claude');
  if (onPathClaude) return onPathClaude;
  const extensions = path.join(os.homedir(), '.vscode', 'extensions');
  if (!fs.existsSync(extensions)) return null;
  const bundled = fs.readdirSync(extensions)
    .filter(dir => dir.startsWith('anthropic.claude-code-'))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(dir => path.join(extensions, dir, 'resources', 'native-binary', 'claude'))
    .find(file => fs.existsSync(file));
  return bundled ?? null;
}

// Variables Claude Code sets for its own child processes. Removed so the check behaves the same
// whether it is started from a terminal or from inside a Claude Code session.
const OUTER_CLAUDE_SESSION = { CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDE_CODE_SSE_PORT: undefined };
// Read-only, no MCP servers, nothing saved. Sonnet keeps the run cheap and off Opus/Fable limits.
const CLAUDE_ARGS = ['-p', PROMPT, '--model', 'sonnet', '--allowedTools', 'Read', '--strict-mcp-config', '--no-session-persistence'];

// Codex speaks only the Responses API. A custom provider keeps WebSocket off (the built-in `openai`
// provider tries WebSocket first, which would hide history from the gate) and
// `requires_openai_auth` keeps Codex's own login. `-c` values are TOML, keys use dot notation.
const CODEX_ARGS = [
  'exec', '-s', 'read-only', '--ephemeral',
  '-c', 'model_provider="slm-gate-spike"',
  '-c', 'model_providers.slm-gate-spike.name="slm-gate-spike"',
  '-c', `model_providers.slm-gate-spike.base_url="${BASE_URL}/v1"`,
  '-c', 'model_providers.slm-gate-spike.requires_openai_auth=true',
  PROMPT,
];

/**
 * Reads Claude Code's `--output-format json` result: later steps of a session must read the prompt
 * cache, which only happens when the history before them came back byte-identical.
 */
function claudeCacheReads(output: string): string {
  const line = output.split('\n').find(text => text.startsWith('{') && text.includes('"usage"'));
  if (!line) return 'FAIL: no JSON result from Claude Code';
  try {
    const reads = Number(JSON.parse(line).usage?.cache_read_input_tokens ?? 0);
    return reads > 0 ? `prompt-cache reads: ${reads} tokens` : 'FAIL: usage shows no prompt-cache reads';
  } catch {
    return 'FAIL: unreadable JSON result from Claude Code';
  }
}

/** Gemini CLI's selected auth type (security.auth.selectedType), which beats GEMINI_API_KEY. */
function geminiAuthType(): string | null {
  const file = path.join(os.homedir(), '.gemini', 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).security?.auth?.selectedType ?? null;
  } catch {
    return null;
  }
}

/** agy's model provider setting; unset means Google sign-in. */
function agyModelProvider(): string | null {
  const file = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).modelProvider ?? null;
  } catch {
    return null;
  }
}

const CHECKS: Check[] = [
  {
    kind: 'auto',
    id: 'claude-code-subscription',
    title: 'Claude Code, claude.ai Pro/Max login',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-oauth',
    findBinary: findClaude,
    args: CLAUDE_ARGS,
    // Any key in the environment would replace the subscription login.
    env: { ...OUTER_CLAUDE_SESSION, ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined },
  },
  {
    kind: 'auto',
    id: 'claude-code-api-key',
    title: 'Claude Code, ANTHROPIC_API_KEY',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    findBinary: findClaude,
    args: CLAUDE_ARGS,
    env: { ...OUTER_CLAUDE_SESSION, ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: undefined },
    requiredEnv: ['ANTHROPIC_API_KEY'],
  },
  {
    kind: 'auto',
    id: 'gemini-cli-api-key',
    title: 'Gemini CLI, GEMINI_API_KEY',
    pathPrefix: '/v1beta/',
    // Google issues keys in more than one format, so only presence is checked.
    credential: 'any',
    findBinary: () => onPath('gemini'),
    // 'plan' is the CLI's read-only approval mode; --skip-trust stops headless runs failing in a
    // folder not yet trusted. Relies on ~/.gemini/settings.json selecting API-key auth: the setting
    // beats GEMINI_API_KEY, and a Google-account login ignores the base URL.
    args: ['-p', PROMPT, '--approval-mode', 'plan', '--skip-trust'],
    env: { GOOGLE_GEMINI_BASE_URL: BASE_URL },
    requiredEnv: ['GEMINI_API_KEY'],
    // Any other auth type (Google login, Vertex, or unset, which the CLI resolves from the
    // environment) would not reach the spike, or would reach it on a login the gate must not route.
    skipReason: () => geminiAuthType() === 'gemini-api-key'
      ? null
      : 'Gemini CLI is not on API-key auth; set security.auth.selectedType to "gemini-api-key" in ~/.gemini/settings.json',
  },
  {
    kind: 'auto',
    id: 'claude-code-distill',
    title: 'Claude Code through Step B: large Grep result, then another step',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-oauth',
    distillCheck: true,
    findBinary: findClaude,
    args: [
      // Each step needs the one before, so the distilled Grep result is resent as history at least
      // twice; a changed byte there would cost the cache read or draw a 400.
      '-p', 'Step 1: use the Grep tool to search for the word "import" in the src directory (output mode content, no head limit). Step 2: after you have those results, use the Read tool to read the first 5 lines of the first file they mention. Step 3: after that, use the Read tool to read ./package.json. Reply with only the value of its "name" field.',
      '--model', 'sonnet', '--allowedTools', 'Grep', 'Read', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json',
    ],
    env: { ...OUTER_CLAUDE_SESSION, ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined },
    outputCheck: claudeCacheReads,
  },
  {
    kind: 'auto',
    id: 'gemini-cli-distill',
    title: 'Gemini CLI through Step B: large grep_search result, then another step',
    pathPrefix: '/v1beta/',
    credential: 'any',
    distillCheck: true,
    findBinary: () => onPath('gemini'),
    args: [
      '-p', 'Step 1: search the src directory for the text "import" with your search tool and look at every match. Step 2: after you have those results, read the first file they mention. Step 3: after that, read ./package.json. Reply with only the value of its "name" field.',
      '--approval-mode', 'plan', '--skip-trust',
    ],
    env: { GOOGLE_GEMINI_BASE_URL: BASE_URL },
    requiredEnv: ['GEMINI_API_KEY'],
    skipReason: () => geminiAuthType() === 'gemini-api-key'
      ? null
      : 'Gemini CLI is not on API-key auth; set security.auth.selectedType to "gemini-api-key" in ~/.gemini/settings.json',
  },
  {
    kind: 'auto',
    id: 'agy-api-key',
    title: 'Antigravity CLI (agy), GEMINI_API_KEY',
    // agy's exact request paths are not documented; on a miss the result lists the paths it saw.
    pathPrefix: '/v1beta/',
    credential: 'any',
    findBinary: () => onPath('agy'),
    // File reads are auto-allowed in headless mode; shell commands are soft-denied.
    args: ['-p', PROMPT],
    env: { GOOGLE_GEMINI_BASE_URL: BASE_URL },
    requiredEnv: ['GEMINI_API_KEY'],
    // Google sign-in is never routed through the gate (Google's terms), so only API-key mode is tested.
    skipReason: () => agyModelProvider() === 'gemini'
      ? null
      : 'agy is on Google sign-in; set "modelProvider": "gemini" in ~/.gemini/antigravity-cli/settings.json to test API-key mode',
  },
  {
    kind: 'auto',
    id: 'codex-chatgpt-login',
    title: 'Codex CLI, ChatGPT login',
    pathPrefix: '/v1/responses',
    // Expected shape of a ChatGPT access token; the result also prints the spike's login signals,
    // which is how the gate will tell this login from an API key.
    credential: 'jwt',
    findBinary: () => onPath('codex'),
    args: CODEX_ARGS,
    env: { CODEX_API_KEY: undefined, OPENAI_API_KEY: undefined },
  },
  {
    kind: 'auto',
    id: 'codex-api-key',
    title: 'Codex CLI, CODEX_API_KEY',
    pathPrefix: '/v1/responses',
    credential: 'sk-key',
    findBinary: () => onPath('codex'),
    args: CODEX_ARGS,
    env: {},
    requiredEnv: ['CODEX_API_KEY'],
  },
  {
    kind: 'auto',
    id: 'opencode-api-key',
    title: 'OpenCode, ANTHROPIC_API_KEY',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    findBinary: () => onPath('opencode'),
    args: ['run', '-m', 'anthropic/claude-sonnet-5', PROMPT],
    // Inline config: the built-in anthropic provider pointed at the spike (its base URL includes /v1);
    // edits and shell denied so only reads can run.
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { anthropic: { options: { baseURL: `${BASE_URL}/v1` } } },
        permission: { edit: 'deny', bash: 'deny' },
      }),
    },
    requiredEnv: ['ANTHROPIC_API_KEY'],
  },
  {
    kind: 'auto',
    id: 'kilo-cli-api-key',
    title: 'Kilo Code CLI, ANTHROPIC_API_KEY',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    findBinary: () => onPath('kilo'),
    args: ['run', '-m', 'slm-gate-spike/claude-sonnet-5', PROMPT],
    // Config passed in KILO_CONFIG_CONTENT is trusted, so {env:...} resolves. Non-interactive runs
    // reject every permission request, so only reads can run.
    env: {
      KILO_CONFIG_CONTENT: JSON.stringify({
        provider: {
          'slm-gate-spike': {
            npm: '@ai-sdk/anthropic',
            name: 'slm-gate spike',
            options: { baseURL: `${BASE_URL}/v1`, apiKey: '{env:ANTHROPIC_API_KEY}' },
            models: { 'claude-sonnet-5': {} },
          },
        },
      }),
    },
    requiredEnv: ['ANTHROPIC_API_KEY'],
  },
  {
    kind: 'auto',
    id: 'aider-api-key',
    title: 'Aider, ANTHROPIC_API_KEY',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    toolStep: false,
    findBinary: () => onPath('aider'),
    // Ask mode + dry run: it answers, never edits or commits. Aider calls models through LiteLLM,
    // whose Anthropic base-URL variable is ANTHROPIC_API_BASE.
    args: ['--message', PROMPT, '--read', 'package.json', '--chat-mode', 'ask', '--dry-run', '--no-auto-commits', '--model', 'anthropic/claude-sonnet-5'],
    env: { ANTHROPIC_API_BASE: BASE_URL },
    requiredEnv: ['ANTHROPIC_API_KEY'],
  },

  // Manual checks: IDEs have no headless mode, so you set the tool up and send the prompt yourself.
  {
    kind: 'manual',
    id: 'claude-code-vscode',
    title: 'Claude Code VS Code extension, Pro/Max login',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-oauth',
    steps: [
      `VS Code user settings: "claudeCode.environmentVariables": [{ "name": "ANTHROPIC_BASE_URL", "value": "${BASE_URL}" }], then reload the window`,
      'Open a new Claude Code conversation in this repository (remove the setting again afterwards)',
    ],
  },
  {
    kind: 'manual',
    id: 'cline-extension',
    title: 'Cline (VS Code), Anthropic API key',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    steps: [
      'Cline settings: API Provider "Anthropic", your Anthropic API key',
      `Tick "Use custom base URL" and enter ${BASE_URL}`,
      'Start a new task in this repository',
    ],
  },
  {
    kind: 'manual',
    id: 'roo-extension',
    title: 'Roo Code (VS Code; repository archived 2026-05-15), Anthropic API key',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    steps: [
      'Roo Code settings: provider "Anthropic", your Anthropic API key',
      `Tick "Use custom base URL" and enter ${BASE_URL}`,
      'Start a new task in this repository',
    ],
  },
  {
    kind: 'manual',
    id: 'kilo-extension',
    title: 'Kilo Code (VS Code), Anthropic API key',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    steps: [
      `Settings > Providers > Custom provider: Provider API "Anthropic Messages", Base URL ${BASE_URL}/v1, your Anthropic API key, model claude-sonnet-5`,
      'Start a new task in this repository with that model',
    ],
  },
  {
    kind: 'manual',
    id: 'continue-extension',
    title: 'Continue (VS Code / JetBrains), Anthropic API key',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    steps: [
      `~/.continue/config.yaml, under models: name: slm-gate-spike, provider: anthropic, model: claude-sonnet-5, apiBase: ${BASE_URL}/v1/, apiKey: your Anthropic key`,
      'Select slm-gate-spike in Continue and start a new agent chat in this repository',
    ],
  },
  {
    kind: 'manual',
    id: 'zed',
    title: 'Zed, Anthropic API key',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    steps: [
      `Zed settings.json: "language_models": { "anthropic": { "api_url": "${BASE_URL}" } }`,
      'Enter your Anthropic key in Agent Settings (Zed says keys do not belong in settings.json)',
      'Open a new agent thread on this repository with a Claude model',
    ],
  },
  {
    kind: 'manual',
    id: 'copilot-custom-endpoint',
    title: 'GitHub Copilot Chat (VS Code) Custom Endpoint, Anthropic API key',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    steps: [
      'Chat > Manage Language Models > Add Models > Custom Endpoint',
      `apiType "messages", model id claude-sonnet-5, url ${BASE_URL}/v1/messages, your Anthropic key`,
      'Pick that model in agent mode and start a new chat in this repository (inline suggestions and semantic search do not use it)',
    ],
  },
  {
    kind: 'manual',
    id: 'junie-cli',
    title: 'JetBrains Junie CLI, Anthropic API key',
    pathPrefix: '/v1/messages',
    credential: 'anthropic-api-key',
    steps: [
      `Create ~/.junie/models/slm-gate-spike.json: { "id": "claude-sonnet-5", "baseUrl": "${BASE_URL}/v1/messages", "apiType": "Anthropic", "apiKey": "<your Anthropic key>" } (Junie uses baseUrl as the full endpoint)`,
      'In this repository run: junie --model custom:slm-gate-spike "<the prompt below>"',
    ],
  },
];

/** The credential kind the spike logged for a request: '<kind len=N>' in a header or the key param. */
function credentialKind(entry: LogEntry): string {
  const shapes = [entry.headers?.authorization, entry.headers?.['x-api-key'], entry.headers?.['x-goog-api-key'], entry.query?.key];
  for (const shape of shapes) {
    const match = shape && /<([\w-]+) len=\d+>/.exec(shape);
    if (match) return match[1];
  }
  return 'none';
}

function carriesToolResult(entry: LogEntry): boolean {
  const { types = {}, roles = {}, keys = {} } = entry.body ?? {};
  return Boolean(types.tool_result || types.function_call_output || roles.tool || keys.functionResponse || keys.tool_call_id);
}

function statusOf(entry: LogEntry): number {
  return entry.response?.status ?? entry.status ?? 0;
}

function readLogFrom(offset: number): LogEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs.readFileSync(LOG_PATH).subarray(offset).toString('utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line) as LogEntry);
}

function logSize(): number {
  return fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;
}

/** Runs a read-only query on the gate's throwaway ledger; empty until the gate has created it. */
function queryGateLedger<T>(sql: string, ...args: unknown[]): T[] {
  if (!fs.existsSync(GATE_LEDGER)) return [];
  const db = new Database(GATE_LEDGER, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } catch {
    return []; // events table not created yet
  } finally {
    db.close();
  }
}

/** Where the record currently ends: a byte offset in the spike log, or the last ledger rowid. */
function recordMark(): number {
  if (!THROUGH_GATE) return logSize();
  return queryGateLedger<{ last: number }>('SELECT COALESCE(MAX(rowid), 0) AS last FROM events')[0]?.last ?? 0;
}

/** What was recorded after a mark, in the spike log's shape (the gate's rows carry path and status only). */
function entriesSince(mark: number): LogEntry[] {
  if (!THROUGH_GATE) return readLogFrom(mark);
  return queryGateLedger<{ route: string; meta: string }>("SELECT route, meta FROM events WHERE layer = 'llm' AND rowid > ? ORDER BY rowid", mark)
    .map(row => ({ route: row.route, meta: JSON.parse(row.meta) as { path: string; status: number } }))
    .map(({ route, meta }) => ({ path: meta.path, status: meta.status, route }));
}

/**
 * Removes credentials from a tool's own output before it is printed: the exact values of key-like
 * variables in this environment (any format), then the key shapes spike-passthrough.ts also scrubs
 * (CREDENTIAL_IN_TEXT there), which catch partial echoes such as "sk-proj-****abcd".
 */
function scrub(text: string): string {
  let clean = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /KEY|TOKEN|SECRET/i.test(name)) clean = clean.split(value).join('<redacted>');
  }
  return clean.replace(/(sk-[\w*-]+|AIza[\w*-]+|eyJ[\w.*-]+)/g, '<redacted>');
}

/** Judges a check from the log lines it produced and, for automatic checks, the tool's own result. */
function judge(params: { check: Check; entries: LogEntry[]; run?: { exitCode: number | null; output: string } }): Outcome {
  const { check, entries, run } = params;
  const notes: string[] = [];
  const mine = entries.filter(e => e.path.startsWith(check.pathPrefix));

  if (mine.length === 0) {
    const elsewhere = [...new Set(entries.map(e => e.path))].join(', ');
    notes.push(`no request reached the spike on ${check.pathPrefix}${elsewhere ? ` (saw: ${elsewhere})` : ' — the tool may be ignoring the base URL'}`);
  } else {
    notes.push(`${mine.length} request(s) on ${check.pathPrefix}`);
    if (!mine.some(e => statusOf(e) >= 200 && statusOf(e) < 300)) notes.push('FAIL: no request succeeded');
    for (const e of mine.filter(e => statusOf(e) >= 400)) {
      notes.push(`HTTP ${statusOf(e)}: ${(e.response?.errorSample ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    if (THROUGH_GATE) {
      // The ledger shows no tool results, so a tool step is inferred from a second successful call.
      const succeeded = mine.filter(e => statusOf(e) >= 200 && statusOf(e) < 300).length;
      const needed = check.toolStep === false ? 1 : 2;
      if (succeeded < needed) notes.push(`FAIL: ${succeeded} successful model request(s); a tool step needs at least ${needed}`);
      if (check.distillCheck) {
        const distilled = mine.filter(e => e.route === 'forward_compressed').length;
        notes.push(`${distilled} request(s) went out distilled`);
        if (distilled === 0) notes.push('FAIL: no request went out distilled');
        if (mine.some(e => statusOf(e) === 400)) notes.push('FAIL: a request was rejected with 400 (changed history?)');
      }
    } else {
      if (check.toolStep !== false && !mine.some(carriesToolResult)) {
        notes.push('FAIL: no request carried a tool result, so the tool step did not pass through');
      }
      const kinds = [...new Set(mine.map(credentialKind))];
      notes.push(`credential: ${kinds.join(', ')}`);
      const wrongLogin = check.credential === 'any' ? kinds.includes('none') : kinds.some(k => k !== check.credential);
      if (wrongLogin) notes.push(`FAIL: expected credential ${check.credential === 'any' ? 'to be present' : check.credential}`);
      const signals = mine.find(e => e.loginSignals)?.loginSignals;
      if (signals) notes.push(`login signals: ${JSON.stringify(signals)}`);
    }
  }

  if (run) {
    if (run.exitCode !== 0) notes.push(`FAIL: tool exited with code ${run.exitCode}`);
    if (!run.output.includes(EXPECTED_ANSWER)) notes.push(`FAIL: answer did not contain "${EXPECTED_ANSWER}"`);
    const problem = check.kind === 'auto' ? check.outputCheck?.(run.output) : null;
    if (problem) notes.push(problem);
  }

  const failed = mine.length === 0 || notes.some(n => n.startsWith('FAIL'));
  return { result: failed ? 'FAIL' : 'PASS', notes };
}

function runTool(params: { binary: string; check: AutoCheck }): Promise<{ exitCode: number | null; output: string }> {
  const { binary, check } = params;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(check.env)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return new Promise(resolve => {
    const child = spawn(binary, check.args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    const timer = setTimeout(() => {
      output += `\n[spike-check] timed out after ${TOOL_TIMEOUT_MS / 1000}s`;
      child.kill('SIGTERM');
      // A tool that ignores SIGTERM, or a grandchild still holding the pipes, must not hang the
      // run: 'close' only fires once the process has exited AND its pipes are closed.
      setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, 5000).unref();
    }, TOOL_TIMEOUT_MS);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: `${output}\n[spike-check] could not start: ${err.message}` });
    });
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({ exitCode, output });
    });
  });
}

async function runCheck(check: Check, prompt: readline.Interface): Promise<Outcome> {
  if (check.kind === 'manual') {
    console.log(`\n${check.title}\n${check.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n  Then send this prompt: ${PROMPT}`);
    const mark = recordMark();
    const answer = (await prompt.question(`  Once the IDE has answered: did it reply "${EXPECTED_ANSWER}"? [y / n / s = skip] `)).trim().toLowerCase();
    if (answer === 's' || answer === 'skip') return { result: 'SKIP', notes: ['skipped by you'] };
    const outcome = judge({ check, entries: entriesSince(mark) });
    if (answer !== 'y' && answer !== 'yes') {
      outcome.result = 'FAIL';
      outcome.notes.push('FAIL: you reported the answer was wrong or missing');
    }
    return outcome;
  }

  const binary = check.findBinary();
  if (!binary) return { result: 'SKIP', notes: ['tool not installed'] };
  const missing = (check.requiredEnv ?? []).filter(name => !process.env[name]);
  if (missing.length > 0) return { result: 'SKIP', notes: [`not set: ${missing.join(', ')}`] };
  if (check.distillCheck && !THROUGH_GATE) return { result: 'SKIP', notes: ['a distillation check; runs only with --gate'] };
  const reason = check.skipReason?.();
  if (reason) return { result: 'SKIP', notes: [reason] };

  console.log(`\n${check.title}: running ${path.basename(binary)} ...`);
  const mark = recordMark();
  const run = await runTool({ binary, check });
  // The spike writes its log line when a stream ends, which can land just after the tool exits.
  await new Promise(resolve => setTimeout(resolve, 500));
  const outcome = judge({ check, entries: entriesSince(mark), run });
  if (outcome.result === 'FAIL') outcome.notes.push(`tool output (tail): ${scrub(run.output).trim().slice(-400)}`);
  return outcome;
}

/** Starts the spike, or with --gate the real llm-gate, and resolves once it is listening. */
function startProxy(): Promise<ReturnType<typeof spawn>> {
  const { script, env, readyText } = THROUGH_GATE
    ? {
        script: path.join(ROOT, 'src', 'llm-gate', 'index.ts'),
        // Throwaway ledger and Langfuse off, so check rows never reach real metrics. Blank values also
        // stop the repo's .env from filling them in (config treats blank as unset).
        env: { LLM_GATE_PORT: String(PORT), LEDGER_PATH: GATE_LEDGER, LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '', LANGFUSE_HOST: '' },
        readyText: 'LLM Gate running on port',
      }
    : { script: path.join(ROOT, 'scripts', 'spike-passthrough.ts'), env: { SPIKE_PORT: String(PORT) }, readyText: 'listening' };

  return new Promise((resolve, reject) => {
    const proxy = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proxy.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.includes(readyText)) resolve(proxy);
    });
    proxy.on('close', code => reject(new Error(`${path.basename(script)} exited (code ${code}) before listening:\n${stderr}`)));
  });
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2);
  if (ids.includes('--list')) {
    for (const c of CHECKS) console.log(`${c.id.padEnd(28)} ${c.kind.padEnd(7)} ${c.title}`);
    return;
  }
  const manualOnly = ids.includes('--manual');
  const named = ids.filter(id => id !== '--manual' && id !== '--gate');
  const unknown = named.filter(id => !CHECKS.some(c => c.id === id));
  if (unknown.length > 0) throw new Error(`unknown check(s): ${unknown.join(', ')} (see --list)`);
  const selected = named.length > 0 ? CHECKS.filter(c => named.includes(c.id))
    : CHECKS.filter(c => c.kind === (manualOnly ? 'manual' : 'auto'));

  const proxy = await startProxy();
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const results: { check: Check; outcome: Outcome }[] = [];
  try {
    for (const check of selected) {
      results.push({ check, outcome: await runCheck(check, prompt) });
    }
  } finally {
    prompt.close();
    proxy.kill();
    // The gate's throwaway ledger (and its WAL files) belong to this run only.
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(GATE_LEDGER + suffix, { force: true });
  }

  console.log(`\n=== checks through the ${THROUGH_GATE ? 'llm-gate' : 'Slice 0 spike'} ===`);
  for (const { check, outcome } of results) {
    console.log(`${outcome.result.padEnd(4)}  ${check.id}`);
    for (const note of outcome.notes) console.log(`        ${note}`);
  }
  if (results.some(r => r.outcome.result === 'FAIL')) process.exitCode = 1;
}

main().catch(err => {
  console.error(`[spike-check] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
