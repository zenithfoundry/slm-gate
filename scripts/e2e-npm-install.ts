/**
 * @fileoverview End-to-end check of the npm package, installed the way a user installs it.
 *
 * Packs this build, installs it with plain `npm install -g` into a throwaway folder, and runs it with a
 * throwaway home folder, like a new computer:
 *   1. `slm-gate init --ram 64` writes ~/.slm-gate/.env; `slm-gate config` reads it from there, while the
 *      code stays in node_modules.
 *   2. A coding tool's MCP entry for `slm-gate mcp`, with DOWNSTREAM_MCP pointing at a stand-in toolbox, is
 *      recognised as the toolbox's gateway by the rule TLS's install.sh uses, and slm-gate serves the
 *      toolbox's tools as its own: a tool call goes through.
 *   3. Upgrading to a newer package leaves ~/.slm-gate (settings and ledger) untouched, and it still runs.
 *
 * Needs `pnpm run build` first and network access for npm. Needs no Ollama: a stand-in answers the MCP
 * server's start-up check.
 *
 * Usage: pnpm run e2e:npm-install
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = 'toolbox_hello';
const TOOL_REPLY = 'hello from the toolbox';

let failures = 0;

function check(ok: boolean, message: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`);
  if (!ok) failures++;
}

/** Runs a command and returns its stdout; throws with its output when it fails. */
function run(params: { command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }): string {
  const result = spawnSync(params.command, params.args, { cwd: params.cwd ?? ROOT, env: params.env ?? process.env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${params.command} ${params.args.join(' ')} exited with ${result.status}:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** An Ollama stand-in that lists `models` as downloaded and answers any generation with an empty result. */
async function standInOllama(models: string[]): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/api/tags' || req.url?.startsWith('/api/chat') || req.url?.startsWith('/api/generate') ? 200 : 404,
      { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/tags'
      ? { models: models.map(name => ({ name })) }
      : { model: models[0], message: { role: 'assistant', content: '{}' }, response: '{}', done: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

/** Writes a one-tool MCP server (the stand-in toolbox) into `dir`, using this checkout's MCP SDK. */
function writeToolbox(dir: string): string {
  const sdk = (file: string) => pathToFileURL(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', file)).href;
  const file = path.join(dir, 'toolbox.mjs');
  fs.writeFileSync(file, `
import { Server } from '${sdk('server/index.js')}';
import { StdioServerTransport } from '${sdk('server/stdio.js')}';
import { CallToolRequestSchema, ListToolsRequestSchema } from '${sdk('types.js')}';
const server = new Server({ name: 'stand-in-toolbox', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: '${TOOL}', description: 'Says hello', inputSchema: { type: 'object', properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: '${TOOL_REPLY}' }] }));
await server.connect(new StdioServerTransport());
`);
  return file;
}

/** Resolves once process `pid` has exited (at most ~5 s), so it has finished writing its files. */
async function exited(pid: number | null): Promise<void> {
  for (let i = 0; pid && i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Starts slm-gate from an MCP entry like a coding tool, lists its tools and calls the toolbox's tool. */
async function useGate(params: { entry: { command: string; args: string[]; env: Record<string, string> }; cwd: string }):
  Promise<{ tools: string[]; reply: string; errors: number }> {
  const { entry, cwd } = params;
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: entry.env, cwd, stderr: 'ignore' });
  const client = new Client({ name: 'npm-install-e2e', version: '1.0.0' });
  let errors = 0;
  client.onerror = () => { errors++; };
  await client.connect(transport);
  const pid = transport.pid;
  try {
    const { tools } = await client.listTools();
    const result = await client.callTool({ name: TOOL, arguments: {} });
    const reply = (result.content as Array<{ text?: string }>).map(part => part.text ?? '').join('');
    return { tools: tools.map(tool => tool.name).sort(), reply, errors };
  } finally {
    await client.close();
    await exited(pid);
  }
}

/** A hash of every file under `dir`, by relative path. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return files;
}

/** The same package with a newer version number, standing in for the next release. */
function newerPackage(params: { tarball: string; work: string }): { tarball: string; version: string } {
  const dir = path.join(params.work, 'newer');
  fs.mkdirSync(dir);
  run({ command: 'tar', args: ['-xzf', params.tarball, '-C', dir] });
  const manifestPath = path.join(dir, 'package', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = `${manifest.version}-upgrade-check`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const tarball = path.join(dir, 'newer.tgz');
  run({ command: 'tar', args: ['-czf', tarball, '-C', dir, 'package'] });
  return { tarball, version: manifest.version };
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'cli.js'))) {
    console.error('FAIL: dist/cli.js not found. Run `pnpm run build` first.');
    process.exit(1);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-npm-e2e-'));
  const prefix = path.join(work, 'prefix');
  const home = path.join(work, 'home');
  const toolboxDir = path.join(work, 'toolbox');
  fs.mkdirSync(home);
  fs.mkdirSync(toolboxDir);
  // npm run under pnpm inherits pnpm's npm_config_* settings; a user's npm has none of them.
  const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_(config|package)_/i.test(name)));
  // A new computer: nothing but PATH and a home folder with no settings in it.
  const userEnv = { PATH: process.env.PATH ?? '', HOME: home };
  let ollama: { url: string; close: () => void } | undefined;

  try {
    console.log('Packing and installing with npm (needs network)...');
    run({ command: 'pnpm', args: ['pack', '--pack-destination', work] });
    const tarball = path.join(work, fs.readdirSync(work).find(file => file.endsWith('.tgz'))!);
    run({ command: 'npm', args: ['install', '-g', '--prefix', prefix, tarball], env: npmEnv });
    const bin = path.join(prefix, 'bin', 'slm-gate');
    const packageDir = path.join(prefix, 'lib', 'node_modules', '@zenithfoundry', 'slm-gate');

    // 1. Settings live in ~/.slm-gate; the code stays in node_modules.
    const settingsDir = path.join(home, '.slm-gate');
    const initOutput = run({ command: bin, args: ['init', '--ram', '64'], env: userEnv, cwd: home });
    check(fs.existsSync(path.join(settingsDir, '.env')) && initOutput.includes('RAM_PRESET=ram-64'), 'init wrote ~/.slm-gate/.env, set up for 64 GB');
    const configOutput = run({ command: bin, args: ['config'], env: userEnv, cwd: home });
    // The settings as JSON, between the heading and the summary that follows.
    const config = JSON.parse(configOutput.match(/^\{$[\s\S]*?^\}$/m)?.[0] ?? '{}');
    check(config.HOME_DIR === settingsDir && config.RAM_PRESET === 'ram-64', 'config reads the settings from ~/.slm-gate');
    // slm-gate reports real paths; the temp folder can be behind a link (macOS: /var → /private/var).
    check(config.ROOT_DIR === fs.realpathSync(packageDir), 'the code stays in the npm install folder');
    check(config.LEDGER_PATH === path.join(settingsDir, 'output', 'ledger.sqlite'), 'the ledger lives in ~/.slm-gate/output');

    // 2. A coding tool's entry, with a toolbox behind slm-gate. Ollama has exactly what init said to download.
    const toDownload = [...initOutput.matchAll(/ollama pull (\S+)/g)].map(match => match[1]);
    ollama = await standInOllama(toDownload);
    const toolbox = writeToolbox(toolboxDir);
    const entry = {
      command: bin,
      args: ['mcp'],
      env: { ...userEnv, OLLAMA_HOST: ollama.url, LLM_GATE_AUTOSTART: 'off', DOWNSTREAM_MCP: JSON.stringify({ command: process.execPath, args: [toolbox] }) },
    };
    const clientConfig: { mcpServers: Record<string, unknown> } = { mcpServers: { 'slm-gate': entry } };
    // TLS install.sh: a registered server whose definition mentions the toolbox's folder is its gateway.
    const gateways = Object.keys(clientConfig.mcpServers).filter(name => JSON.stringify(clientConfig.mcpServers[name]).includes(toolboxDir));
    check(gateways.join(',') === 'slm-gate', 'the MCP entry is recognised as the toolbox gateway, the way TLS install.sh looks for one');
    const first = await useGate({ entry, cwd: home });
    check(first.tools.includes(TOOL), `slm-gate serves the toolbox's tools as its own (${first.tools.join(', ')})`);
    check(first.reply.includes(TOOL_REPLY), 'a toolbox tool call goes through slm-gate');
    check(first.errors === 0, 'the MCP server writes nothing but protocol messages to stdout');
    const notices = path.join(settingsDir, 'output', '.notices');
    const raised = fs.existsSync(notices) ? fs.readdirSync(notices) : [];
    check(raised.length === 0, `with the models init listed (${toDownload.join(', ')}), start-up raises no warning`);

    // 3. An upgrade replaces the code and nothing in ~/.slm-gate.
    const before = snapshot(settingsDir);
    const newer = newerPackage({ tarball, work });
    run({ command: 'npm', args: ['install', '-g', '--prefix', prefix, newer.tarball], env: npmEnv });
    const installed = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version;
    check(installed === newer.version, `upgraded the install to ${newer.version}`);
    const after = snapshot(settingsDir);
    check(JSON.stringify(after) === JSON.stringify(before), `the upgrade left ~/.slm-gate untouched (${Object.keys(before).sort().join(', ')})`);
    const upgraded = await useGate({ entry, cwd: home });
    check(upgraded.reply.includes(TOOL_REPLY), 'the upgraded install runs with the kept settings');
  } finally {
    ollama?.close();
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll npm install checks passed.' : `\n${failures} npm install check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
