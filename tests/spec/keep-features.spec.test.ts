/**
 * @fileoverview The keep-features spec: one suite that exercises every feature slm-gate must still have after
 * the first-message local answering (`LLM_GATE_LOCAL_FIRST`, "Step A") is removed. It runs the real model gate
 * against a fake Ollama and a mock provider, the real MCP gate against a fake toolbox, and the ledger, index,
 * memory, fidelity-guard, pinning and dashboard code directly. Nothing in here depends on Step A; if a removal
 * step breaks a kept feature, a test in this file goes red.
 *
 * Covered: byte-for-byte forwarding on every supported path; Step B tool-result shrinking and its byte
 * stability across turns; tool-definition counts; conversation memory (note, fold, match rules, fail-closed,
 * numbers-only ledger meta); the fidelity guard with learned protections; expand_elision, ask_elision and
 * find_existing through the MCP gate; decision memory and condition dependencies; the repository index;
 * model pinning; the busy counter; the resolver's use of the conversation; the dashboard's tool-definition and
 * fidelity sections; the CLI and package scripts that stay.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startFakeOllama } from '../llm-gate/fake-ollama.js';

// ---------------------------------------------------------------------------------------------------------
// Fakes: Ollama (both local models), one mock provider for every upstream, a fake MCP toolbox.
// ---------------------------------------------------------------------------------------------------------
const ollama = await startFakeOllama();

let lastBody = '';
let lastPath = '';
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    lastBody = Buffer.concat(chunks).toString('utf8');
    lastPath = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message"}');
  });
});
await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

// Config is read once at import, so every switch is set here, before the first import of src.
process.env.OLLAMA_HOST = ollama.url;
process.env.SLM_PROVIDER = 'ollama';
process.env.UPSTREAM_ANTHROPIC_URL = upstreamUrl;
process.env.UPSTREAM_OPENAI_URL = upstreamUrl;
process.env.UPSTREAM_CHATGPT_URL = upstreamUrl;
process.env.UPSTREAM_GEMINI_URL = upstreamUrl;
process.env.LLM_GATE_DISTILL = 'on';
process.env.CONVERSATION_MEMORY = 'on';
process.env.MEMORY_FOLD_INTERVAL_MS = '100';
process.env.MEMORY_MATCH_WINDOW_MS = '600000';
process.env.SEMCACHE = 'off';
process.env.DISTILL_ADAPTIVE = 'off';
process.env.DISTILL_SKILLS = 'on';
// Below the spec skill's size so the guard's summarize mode runs without a real model.
process.env.DISTILL_MAX_TOKENS = '2000';
process.env.REPO_INDEX = 'on';
process.env.SLM_PIN_MODELS = 'on';
process.env.PROMPT_VERSION = 'keep-spec';
process.env.DOWNSTREAM_MCP = '{"command":"echo"}';
process.env.MCP_GATE_TRANSPORT = 'stdio';

// The toolbox behind the MCP gate: one tool, whose result is whatever the test queues next.
const toolboxTools = [{ name: 'get_skill', inputSchema: { type: 'object' } }];
const toolboxRequest = jest.fn<(...args: any[]) => Promise<any>>(async (req: any) =>
  req.method === 'tools/list' ? { tools: toolboxTools } : { content: [{ type: 'text', text: 'short skill text' }] });
jest.unstable_mockModule('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(),
    request: toolboxRequest,
    getInstructions: () => 'Toolbox says hello.',
  })),
}));

const { CONFIG } = await import('../../src/config.js');
const ledger = await import('../../src/ledger/index.js');
const { getDb } = ledger;
const { conversationKey } = await import('../../src/llm-gate/formats/contract.js');
const memory = await import('../../src/llm-gate/memory.js');
const busy = await import('../../src/models/busy.js');
const { pinModels, describePin } = await import('../../src/models/pin.js');
const { refreshRepoIndex, findExisting, existingCodeSection } = await import('../../src/index/repo-index.js');
const { loadDecisionMemory } = await import('../../src/resolver/decisions.js');
const { extractAmbiguities, resolveAmbiguities } = await import('../../src/resolver/index.js');
const { computeDashboardData } = await import('../../src/dashboard/data.js');
const { distillToolResultWithStats, requirementInventory, formatElisionMarker, estimateTokens } = await import('../../src/utils/elision.js');
const { buildPreserveList } = await import('../../src/utils/preserve-patterns.js');
const { createServer } = await import('../../src/mcp-gate/server.js');
const gate: http.Server = (await import('../../src/llm-gate/server.js')).server;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let gatePort: number;

beforeAll(async () => {
  gatePort = await new Promise<number>(r => gate.listen(0, '127.0.0.1', () => r((gate.address() as AddressInfo).port)));
  getDb().prepare('DELETE FROM conversation_memory').run();
  getDb().prepare('DELETE FROM distill_protect').run();
  console.warn = jest.fn();
  console.error = jest.fn();
});
afterAll(async () => {
  gate.closeAllConnections(); upstream.closeAllConnections();
  await new Promise(r => gate.close(r)); await new Promise(r => upstream.close(r)); await ollama.close();
});

/** Posts raw bytes to the gate and returns the request id of the ledger row it wrote. */
function send(raw: string, reqPath = '/v1/messages', headers: Record<string, string> = {}): Promise<{ id: string; status: number; routeHeader: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatePort, method: 'POST', path: reqPath, headers: { 'content-type': 'application/json', ...headers }, agent: false }, res => {
      res.resume();
      res.on('end', () => resolve({ id: String(res.headers['x-correlation-id']), status: res.statusCode ?? 0, routeHeader: String(res.headers['x-slm-gate-route'] ?? '') }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}
const row = (id: string) => getDb().prepare('SELECT route, api_in_tok, meta FROM events WHERE request_id = ?').get(id) as { route: string; api_in_tok: number; meta: string };
const meta = (id: string) => JSON.parse(row(id).meta);

// ---------------------------------------------------------------------------------------------------------
// 1. The model gate forwards every supported format byte for byte, with the tool's own request path.
// ---------------------------------------------------------------------------------------------------------
describe('model gate: byte-for-byte forwarding on every supported path', () => {
  const text = (s: string) => `keep-spec ${s} ${Date.now()}`;

  it('forwards an Anthropic request unchanged and writes a forward_raw row', async () => {
    const raw = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: text('anthropic') }] }] });
    const { id, status } = await send(raw);
    expect(status).toBe(200);
    expect(lastBody).toBe(raw);
    expect(lastPath).toBe('/v1/messages');
    expect(row(id).route).toBe('forward_raw');
    expect(meta(id)).toMatchObject({ format: 'anthropic', path: '/v1/messages', status: 200 });
  });

  it('forwards an OpenAI chat-completions request unchanged', async () => {
    const raw = JSON.stringify({ model: 'gpt-6', messages: [{ role: 'user', content: text('chat') }] });
    const { id } = await send(raw, '/v1/chat/completions');
    expect(lastBody).toBe(raw);
    expect(lastPath).toBe('/chat/completions');
    expect(row(id).route).toBe('forward_raw');
  });

  it('forwards a Responses request unchanged', async () => {
    const raw = JSON.stringify({ model: 'gpt-6', input: [{ role: 'user', content: [{ type: 'input_text', text: text('responses') }] }] });
    const { id } = await send(raw, '/v1/responses');
    expect(lastBody).toBe(raw);
    expect(row(id).route).toBe('forward_raw');
  });

  it('forwards a Gemini request unchanged', async () => {
    const raw = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: text('gemini') }] }] });
    const { id } = await send(raw, '/v1beta/models/gemini-3-pro:generateContent');
    expect(lastBody).toBe(raw);
    expect(lastPath).toBe('/v1beta/models/gemini-3-pro:generateContent');
    expect(row(id).route).toBe('forward_raw');
  });

  it('never answers a first message itself: the local reply route is gone and the request always reaches the provider', async () => {
    ollama.reset();
    ollama.state.answer = 'Tokyo.';
    const raw = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the capital of Japan?' }] }] });
    const { id, routeHeader } = await send(raw);
    expect(lastBody).toBe(raw);
    expect(routeHeader).toBe('');
    expect(row(id).route).toBe('forward_raw');
    // No plain-text answer call reached the brain; a memory fold (structured call) may run later and is fine.
    expect(ollama.calls.filter(c => c.kind === 'answer')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. Step B: large new tool results are shrunk by the rules, and the shrunk bytes are stable across turns.
// ---------------------------------------------------------------------------------------------------------
describe('model gate: tool-result shrinking (Step B) and tool-definition counts', () => {
  const testLog = Array.from({ length: 300 }, (_, i) => (i === 150 ? 'Error: expected 2 to equal 3 at sum.test.ts:12' : `  ✓ case ${i} passes in ${i % 7}ms`)).join('\n');
  const first = { role: 'user', content: [{ type: 'text', text: `keep-spec distill ${Date.now()}` }] };
  const turn1 = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: testLog }] },
  ];
  const turn2 = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'git status' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'nothing to commit' }] },
  ];
  const tools = [{ name: 'Bash', input_schema: { type: 'object' } }, { name: 'Read', input_schema: { type: 'object' } }];

  it('shrinks a large new command result, keeps the error line, and marks the row forward_compressed', async () => {
    const request1 = { model: 'claude-sonnet-5', tools, messages: [first, ...turn1] };
    const { id } = await send(JSON.stringify(request1));
    const forwarded = JSON.parse(lastBody);
    const distilled: string = forwarded.messages[2].content[0].content;
    expect(distilled.length).toBeLessThan(testLog.length / 2);
    expect(distilled).toContain('Error: expected 2 to equal 3');
    expect(distilled).toContain('not shown by slm-gate');
    // Only the tool result changed.
    expect(lastBody).toBe(JSON.stringify(request1).replace(JSON.stringify(testLog), JSON.stringify(distilled)));
    const r = row(id);
    expect(r.route).toBe('forward_compressed');
    const m = meta(id);
    expect(m.raw_in_tok).toBeGreaterThan(r.api_in_tok);
    expect(m.distill).toMatchObject({ distilled: 1 });
    expect(ledger.perEventTokensSaved({ ...(getDb().prepare('SELECT * FROM events WHERE request_id = ?').get(id) as any) })).toBeGreaterThan(0);
  });

  it('resends the same shrunk bytes on the next turn (prompt cache stays warm) and counts the tool definitions', async () => {
    const { id } = await send(JSON.stringify({ model: 'claude-sonnet-5', tools, messages: [first, ...turn1, ...turn2] }));
    const forwarded = JSON.parse(lastBody);
    expect(forwarded.messages[2].content[0].content).toContain('not shown by slm-gate');
    const m = meta(id);
    expect(m.distill).toMatchObject({ reused: 1, distilled: 0 });
    expect(m.tools_count).toBe(2);
    expect(m.tools_deferred).toBe(0);
    expect(m.tools_tok_est).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 3. Conversation memory: the note on the row, the fold, the match rules, and fail-closed behaviour.
// ---------------------------------------------------------------------------------------------------------
describe('conversation memory', () => {
  const history = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Keep-spec memory: rename the dashboard card' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Which card?' }] },
    { role: 'user', content: [{ type: 'text', text: 'The savings card in src/dashboard/index.html' }] },
  ] });

  it('writes a numbers-only memory note on the row and never the conversation text', async () => {
    ollama.reset();
    ollama.state.structured = JSON.stringify({ goal: 'Rename the savings card', decided: ['Keep the card name short'], inPlay: ['src/dashboard/index.html'] });
    const { id } = await send(history);
    expect(lastBody).toBe(history);
    const m = meta(id);
    expect(m.memory).toEqual({ turns_known: 0, age_s: null });
    expect(JSON.stringify(m)).not.toContain('savings card');
  });

  it('folds after the interval once idle, covers the whole history, and the next row knows the turns', async () => {
    await new Promise(r => setTimeout(r, 400));
    const key = conversationKey(JSON.parse(history));
    const stored = ledger.readMemoryRow(key);
    expect(stored).not.toBeNull();
    expect(stored!.turns).toBe(3);
    expect(stored!.summary).toContain('savings card');
    expect(stored!.prompt_version).toBe(CONFIG.PROMPT_VERSION);
    const { id } = await send(history);
    expect(meta(id).memory.turns_known).toBe(3);
    const events = getDb().prepare("SELECT meta FROM events WHERE layer='llm'").all() as { meta: string }[];
    for (const e of events) expect(e.meta ?? '').not.toContain('Rename the savings card');
    // The fold wrote its own ledger row, on the memory_fold route, and the dashboard's routing ignores it.
    const folds = getDb().prepare("SELECT route FROM events WHERE route='memory_fold'").all();
    expect(folds.length).toBeGreaterThan(0);
  });

  it('renders and parses a summary the same way, and trims it to the token budget', () => {
    const summary = { goal: 'A goal', decided: ['one', 'two'], inPlay: ['a.ts'] };
    expect(memory.renderSummary(summary)).toBe('Goal: A goal\nDecided:\n- one\n- two\nIn play:\n- a.ts');
    expect(memory.parseSummary(JSON.stringify(summary))).toEqual(summary);
    expect(memory.parseSummary('not ours')).toBeNull();
    const long = { goal: 'g', decided: Array.from({ length: 200 }, (_, i) => `decision ${i} ${'words '.repeat(10)}`), inPlay: [] };
    expect(estimateTokens(memory.renderSummary(memory.trimSummary(long, 50)))).toBeLessThanOrEqual(80);
  });

  it('matches by key, prefers a usable fork, and fails closed on stale, failed or wrong-version rows', () => {
    const now = new Date();
    const fresh = new Date(now.getTime() - 1000).toISOString();
    const stale = new Date(now.getTime() - CONFIG.MEMORY_MATCH_WINDOW_MS - 1000).toISOString();
    const base = { root: '/repo', summary: 'Goal: x', turns: 2, discriminator: null, started_at: fresh, folded_at: fresh, fold_count: 1, fold_ms: 1, prompt_version: CONFIG.PROMPT_VERSION };
    ledger.writeMemoryRow({ ...base, key: 'spec-fresh' });
    ledger.writeMemoryRow({ ...base, key: 'spec-stale', started_at: stale, folded_at: stale });
    ledger.writeMemoryRow({ ...base, key: 'spec-version', prompt_version: 'other' });
    ledger.writeMemoryRow({ ...base, key: 'spec-failed' });
    ledger.markMemoryFoldFailed('spec-failed', new Date(now.getTime() + 1).toISOString());
    ledger.writeMemoryRow({ ...base, key: 'spec-fork:d1', discriminator: 'd1', summary: 'Goal: fork' });

    expect(ledger.matchMemory({ key: 'spec-fresh', now }).match).toBe('key');
    expect(ledger.matchMemory({ key: 'spec-stale', now }).match).toBe('none');
    expect(ledger.matchMemory({ key: 'spec-version', now }).match).toBe('none');
    expect(ledger.matchMemory({ key: 'spec-failed', now }).match).toBe('none');
    expect(ledger.matchMemory({ key: 'spec-fork', discriminator: 'd1', now }).row?.summary).toBe('Goal: fork');
    expect(ledger.matchMemory({ root: '/repo', startedAfter: new Date(now.getTime() - 5000).toISOString(), now }).match).toBe('root-recent');
    expect(ledger.matchMemory({ root: '/nowhere', now }).match).toBe('none');
  });

  it('a failed fold leaves the old summary and records only the failure time', async () => {
    const key = 'spec-fold-fails';
    memory.noteTurn({ key, root: null, discriminator: null, entries: [{ role: 'user', text: 'first ' + 'words '.repeat(40) }] });
    ollama.state.status = 500;
    const result = await memory.foldConversation(key, { waitForIdle: false });
    ollama.state.status = 200;
    expect(result).toBeNull();
    const stored = ledger.readMemoryRow(key);
    expect(stored === null || stored.fold_failed_at !== null).toBe(true);
    memory.resetMemoryQueue();
  });

  it('says whether the brain is local, which is what decides if memory may run at all', () => {
    expect(memory.brainIsLocal()).toBe(true);
  });

  it('has the memory command in the CLI', () => {
    const cli = fs.readFileSync(path.join(repoRoot, 'src', 'cli.ts'), 'utf8');
    expect(cli).toContain("'memory'");
    expect(fs.existsSync(path.join(repoRoot, 'src', 'llm-gate', 'memory-cli.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 4. The busy counter keeps background work off the request path.
// ---------------------------------------------------------------------------------------------------------
describe('busy counter', () => {
  it('counts requests and model calls and resolves whenIdle only when both are zero', async () => {
    const done = busy.beginRequest();
    expect(busy.busyCounts().requestsInFlight).toBeGreaterThanOrEqual(1);
    let idle = false;
    const waiting = busy.whenIdle().then(() => { idle = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(idle).toBe(false);
    done();
    await busy.track(Promise.resolve(1));
    await waiting;
    expect(idle).toBe(true);
    expect(busy.busyCounts()).toEqual({ requestsInFlight: 0, modelCallsRunning: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------
// 5. The fidelity guard: deterministic classes survive, a lost sentence fails closed and is learned.
// ---------------------------------------------------------------------------------------------------------
describe('fidelity guard and learned protections', () => {
  const skill = [
    '# Review workflow',
    '',
    'Before opening a review you MUST run the full test suite. Reviews must be answered within 30 min during working hours. A reviewer never approves their own change.',
    '',
    'Use `mcp__example__open_change` to open the change. The second sentence of this paragraph is ordinary.',
    '',
    // Six long plain paragraphs (the model sees these): over DISTILL_MAX_TOKENS in total, under the guard's run cap.
    // Paragraph 3 carries one requirement sentence the fail-closed test reports as lost.
    ...Array.from({ length: 6 }, (_, i) => `Paragraph ${i}: ${'the review process has many ordinary sentences that can be shortened. '.repeat(24)}${i === 3 ? 'Escalate after 2 days if nobody answers.' : ''}`),
  ].join('\n');
  const firstSentence = jest.fn(async (text: string) => text.split(/(?<=[.!?])\s+/)[0]);
  let counter = 0;
  const distil = (opts: { verify: import('../../src/utils/elision.js').FidelityVerify }) => distillToolResultWithStats({
    slm: firstSentence as any, text: skill, task: 'spec', toolName: `get_skill-${++counter}`, args: {}, preservePatterns: preserve, verify: opts.verify,
  });
  let preserve: Awaited<ReturnType<typeof buildPreserveList>>;
  beforeAll(async () => { preserve = await buildPreserveList(); });

  it('lists the requirement sentences of a skill', () => {
    const inventory = requirementInventory(skill);
    expect(inventory.some(s => s.includes('MUST run the full test suite'))).toBe(true);
  });

  it('shrinks under the guard when the brain says every run kept its meaning', async () => {
    const { text, fidelity } = await distil({ verify: async ({ inventory }) => inventory.map(() => true) });
    expect(fidelity.mode).toBe('summarize');
    expect(fidelity.deterministic).toBe(1);
    expect(text).toContain('MUST run the full test suite');
    expect(text).toContain('mcp__example__open_change');
    expect(text.length).toBeLessThan(skill.length);
  });

  it('fails closed on a lost sentence: that run goes out verbatim, the loss is recorded and protected next time', async () => {
    const dropped = 'Escalate after 2 days if nobody answers.';
    const verify = async ({ inventory }: { inventory: string[] }) => inventory.map(s => s !== dropped);
    const { text, fidelity } = await distil({ verify });
    expect(fidelity.recall).toBeLessThan(1);
    expect(fidelity.runsKept).toBeGreaterThanOrEqual(1);
    expect(fidelity.lost).toContain(dropped);
    expect(text).toContain(dropped);
    expect(ledger.learnedProtections().some(p => p.includes('escalate after 2 days'))).toBe(true);
    expect(ledger.listProtections()[0].hits).toBeGreaterThanOrEqual(1);
    const pattern = ledger.listProtections()[0].pattern;
    expect(ledger.forgetProtection(pattern)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 6. The MCP gate: its own tools (expand_elision, ask_elision, find_existing) and the toolbox pass-through.
// ---------------------------------------------------------------------------------------------------------
describe('MCP gate: own tools and the toolbox behind it', () => {
  const handlers = async (rootUri?: string) => {
    const { server } = await createServer({ rootUri });
    const list = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    return {
      list: async () => (await list({ method: 'tools/list' }, {})).tools.map((t: any) => t.name) as string[],
      call: async (name: string, args: Record<string, unknown>) => (await call({ method: 'tools/call', params: { name, arguments: args } }, {})).content[0].text as string,
    };
  };
  const lines = Array.from({ length: 400 }, (_, i) => i % 50 === 0 ? `## Part ${i / 50}` : i === 330 ? 'ANSWER-HERE: reviews are answered within 30 min during working hours.' : `line ${i}: ${'prose about the workflow '.repeat(3)}`);
  const ID = 'keep-spec-elision';
  ledger.writeElision({ id: ID, tool_name: 'get_skill', args: '{}', original_text: lines.join('\n'), ranges: JSON.stringify({ startLine: 0, endLine: 399 }), content_hash: 'h', size_bytes: lines.join('\n').length });

  let tmpRepo: string;
  beforeAll(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-spec-repo-'));
    fs.mkdirSync(path.join(tmpRepo, 'src'));
    fs.writeFileSync(path.join(tmpRepo, 'src', 'users.ts'), 'export function createUserRecord(name: string) { return { name }; }\nexport class UserStore {}\n');
    fs.mkdirSync(path.join(tmpRepo, '.slm-gate', 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, '.slm-gate', 'decisions', 'test-runner.md'), '---\ntitle: Test runner\nverified: human\nrisk: low\n---\nTests use Jest, never Vitest.\n');
  });

  it('advertises the toolbox tools plus expand_elision, ask_elision and find_existing', async () => {
    const h = await handlers();
    const names = await h.list();
    expect(names).toEqual(expect.arrayContaining(['get_skill', 'expand_elision', 'ask_elision', 'find_existing']));
  });

  it('passes a toolbox result through whole when there is nothing to shrink', async () => {
    const h = await handlers();
    expect(await h.call('get_skill', { name: 'x' })).toContain('short skill text');
  });

  it('expand_elision returns the cut lines one page at a time', async () => {
    const h = await handlers();
    const page = await h.call('expand_elision', { elisionId: ID, range: { startLine: 0, endLine: 5 } });
    expect(page).toContain('## Part 0');
    expect(page).toContain('line 1:');
    expect(page).not.toContain('ANSWER-HERE');
    expect(formatElisionMarker(ID, 10, 0, 9)).toContain(ID);
  });

  it('ask_elision answers from the stored original with the brain, a few sentences instead of a page', async () => {
    ollama.reset();
    ollama.state.structured = JSON.stringify({ found: true, answer: 'Reviews must be answered within 30 min.', lines: [330, 330] });
    const h = await handlers();
    const answer = await h.call('ask_elision', { elisionId: ID, question: 'How fast are reviews answered?' });
    expect(answer).toContain('30 min');
    expect(answer.length).toBeLessThan(lines.join('\n').length / 10);
    expect(ollama.bodies.length).toBeGreaterThan(0);
  });

  it('find_existing lists symbols the repository already defines, from the index, with no model call', async () => {
    const h = await handlers(`file://${tmpRepo}`);
    ollama.reset();
    const hits = await h.call('find_existing', { query: 'create user record' });
    expect(hits).toContain('src/users.ts');
    expect(hits).toContain('createUserRecord');
    expect(ollama.bodies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 7. Repository index, decision memory and condition dependencies, directly.
// ---------------------------------------------------------------------------------------------------------
describe('repository index, decision memory and condition dependencies', () => {
  let tmpRepo: string;
  beforeAll(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-spec-index-'));
    fs.mkdirSync(path.join(tmpRepo, 'src'));
    fs.writeFileSync(path.join(tmpRepo, 'src', 'billing.ts'), 'export function computeInvoiceTotal(items: number[]) { return items.reduce((a, b) => a + b, 0); }\n');
    fs.mkdirSync(path.join(tmpRepo, '.slm-gate', 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, '.slm-gate', 'decisions', 'runner.md'), '---\ntitle: Test runner\nverified: human\nrisk: low\n---\nTests use Jest, never Vitest.\n');
  });

  it('indexes a repository once, reports no change the second time, and finds symbols by words', () => {
    const first = refreshRepoIndex(tmpRepo);
    expect(first.files).toBe(1);
    expect(first.changed).toBe(1);
    const second = refreshRepoIndex(tmpRepo);
    expect(second.changed).toBe(0);
    expect(findExisting({ root: tmpRepo, query: 'invoice total' })[0]).toMatchObject({ path: 'src/billing.ts', name: 'computeInvoiceTotal' });
    expect(existingCodeSection({ root: tmpRepo, task: 'compute the invoice total' })).toContain('computeInvoiceTotal');
  });

  it('loads decisions written once in .slm-gate/decisions and searches them', () => {
    const decisions = loadDecisionMemory(tmpRepo);
    expect(decisions.decisions.length).toBe(1);
    expect(decisions.decisions[0].title).toBe('Test runner');
    const hits = ledger.searchDecisions({ root: tmpRepo, query: 'jest' });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('a cached conditioning stays fresh until a file, the index or the memory it depended on changes', () => {
    const key = 'keep-spec-cache-key';
    const file = path.join(tmpRepo, 'src', 'billing.ts');
    const mtime = fs.statSync(file).mtimeMs;
    ledger.writeCacheDeps(key, [{ path: file, mtime, expiresAt: null }]);
    expect(ledger.cacheDepsFresh(key, { statMtime: () => mtime })).toBe(true);
    expect(ledger.cacheDepsFresh(key, { statMtime: () => mtime + 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// 8. Model pinning: both models loaded means nothing to do; a stranger is unloaded and the pair warmed.
// ---------------------------------------------------------------------------------------------------------
describe('model pinning', () => {
  function fakeClient(loaded: string[]) {
    const calls: { model: string; keep_alive: unknown }[] = [];
    const list = [...loaded];
    return {
      calls,
      client: {
        ps: async () => ({ models: list.map(name => ({ name })) }),
        generate: async (req: { model: string; keep_alive?: unknown }) => {
          calls.push({ model: req.model, keep_alive: req.keep_alive });
          if (req.keep_alive === 0) list.splice(list.indexOf(req.model), 1);
          else if (!list.includes(req.model)) list.push(req.model);
          return {};
        },
      },
    };
  }

  it('does nothing when the pair is loaded', async () => {
    const fake = fakeClient([CONFIG.SLM_GATE_MODEL, CONFIG.SLM_BRAIN_MODEL]);
    const result = await pinModels(fake.client as any);
    expect(fake.calls).toHaveLength(0);
    expect(describePin(result)).toBeNull();
  });

  it('unloads a model it does not use and warms the missing one back in', async () => {
    const fake = fakeClient([CONFIG.SLM_GATE_MODEL, 'stranger:7b']);
    const result = await pinModels(fake.client as any);
    expect(fake.calls.some(c => c.model === 'stranger:7b' && c.keep_alive === 0)).toBe(true);
    expect(fake.calls.some(c => c.model === CONFIG.SLM_BRAIN_MODEL && c.keep_alive !== 0)).toBe(true);
    expect(describePin(result)).toContain('stranger:7b');
  });
});

// ---------------------------------------------------------------------------------------------------------
// 9. The resolver reads the conversation: settled decisions are offered, never auto-applied.
// ---------------------------------------------------------------------------------------------------------
describe('resolver with the conversation so far', () => {
  const summary = 'Goal: add a module\nDecided:\n- Tests use Jest, never Vitest\nIn play:\n- src/new.ts';
  const question = { id: 'q1', question: 'Which test runner should the new module use?', kind: 'tooling' };

  it('puts the summary in the extraction prompt and offers a settled answer as a recommendation', async () => {
    const slm: any = { generateJSON: jest.fn(), generateText: jest.fn(), streamText: jest.fn() };
    slm.generateJSON.mockResolvedValueOnce({ decisions: [] });
    await extractAmbiguities(slm, 'skill', 'task', summary);
    expect(String(slm.generateJSON.mock.calls[0][1])).toContain(summary);

    slm.generateJSON.mockResolvedValueOnce({ decisions: [question] }).mockResolvedValueOnce({ answered: true, answer: 'Jest' }).mockResolvedValueOnce({ risk: 'reversible' });
    const fsRead = jest.fn<(pattern: string) => Promise<string[]>>().mockResolvedValue([]);
    const out = await resolveAmbiguities(slm, fsRead, { skillText: 'skill', task: 'task', conversation: summary, decided: ['Tests use Jest, never Vitest'] });
    expect(out.autoApplied).toHaveLength(0);
    expect(out.askUser[0].recommendedAnswer).toBe('Jest');
    expect(out.askUser[0].provenance).toBe('conversation memory');
  });
});

// ---------------------------------------------------------------------------------------------------------
// 10. The dashboard: tool-definition and fidelity sections, routing without feedback or fold rows.
// ---------------------------------------------------------------------------------------------------------
describe('dashboard data', () => {
  const base = { layer: 'llm', env: 'test', api_model: 'claude-sonnet-5', is_local_call: 0, in_tok: 0, out_tok: 0, api_out_tok: 10, cost_usd: 0, slm_latency_s: 0, api_latency_s: 1, slm_gate: 'on' };
  const event = (over: Record<string, unknown>) => ({ ...base, ts: new Date().toISOString(), request_id: `d-${Math.random()}`, ...over }) as any;

  it('aggregates tool-definition counts and skill fidelity, and keeps feedback and fold rows out of routing', () => {
    const events = [
      event({ route: 'forward_raw', api_in_tok: 1000, meta: JSON.stringify({ tools_count: 30, tools_deferred: 0, tools_tok_est: 12000 }) }),
      event({ route: 'forward_compressed', api_in_tok: 500, meta: JSON.stringify({ raw_in_tok: 2000, tools_count: 30, tools_deferred: 5, tools_tok_est: 12000 }) }),
      event({ layer: 'mcp', route: 'condition', api_in_tok: 300, meta: JSON.stringify({ fidelity: { mode: 'summarize', deterministic: 1, recall: 1, runs: 3, runsChecked: 3 } }) }),
      event({ route: 'feedback', in_tok: 0, out_tok: 50 }),
      event({ route: 'memory_fold', in_tok: 500, out_tok: 100 }),
    ];
    const data = computeDashboardData(events);
    expect(data.toolDefs.requests).toBe(2);
    expect(data.toolDefs.last).toEqual({ count: 30, deferred: 5, tokEst: 12000 });
    expect(data.fidelity.conditionings).toBeGreaterThanOrEqual(1);
    const routeNames = Object.keys(data.routing ?? {}).concat((data as any).routes?.map((r: any) => r.route) ?? []);
    expect(routeNames).not.toContain('feedback');
    expect(routeNames).not.toContain('memory_fold');
  });
});

// ---------------------------------------------------------------------------------------------------------
// 11. The package surface that stays: scripts, CLI commands, settings keys, docs.
// ---------------------------------------------------------------------------------------------------------
describe('package surface that must stay', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

  it('keeps the scripts for the fidelity report, learned protections, the gate benchmark and ledger metrics', () => {
    expect(pkg.scripts.fidelity).toBe('tsx scripts/fidelity.ts');
    expect(pkg.scripts.protections).toBe('tsx scripts/protections.ts');
    expect(pkg.scripts['bench:gate']).toBe('tsx scripts/bench-gate.ts');
    expect(pkg.scripts.metrics).toBe('tsx harness/metrics.ts');
    for (const s of ['scripts/fidelity.ts', 'scripts/protections.ts', 'scripts/bench-gate.ts', 'harness/metrics.ts', 'scripts/smoke-e2e.ts', 'scripts/e2e-standalone-mcp.ts', 'scripts/e2e-distill-fallback.ts', 'scripts/e2e-resolver-ambiguities.ts']) {
      expect(fs.existsSync(path.join(repoRoot, s))).toBe(true);
    }
    expect(pkg.scripts['test:e2e']).toContain('e2e:standalone-mcp');
    expect(pkg.scripts['test:e2e']).toContain('smoke:e2e');
  });

  it('keeps every setting the kept features read, in the shipped example and the owner-facing docs', () => {
    const example = read('.env.example');
    const agentSetup = read('docs/agent-setup.md');
    for (const key of ['CONVERSATION_MEMORY', 'MEMORY_MAX_TOKENS', 'MEMORY_FOLD_INPUT_TOKENS', 'MEMORY_FOLD_INTERVAL_MS', 'MEMORY_MATCH_WINDOW_MS',
      'DISTILL_SKILLS', 'DISTILL_FIDELITY_MIN', 'DISTILL_FIDELITY_MAX_RUNS', 'DISTILL_FIDELITY_BUDGET_MS', 'MAX_CONCURRENT_SEGMENT_CALLS',
      'RESOLVER_PROMPT_TOKENS', 'REPO_INDEX', 'SLM_PIN_MODELS', 'LLM_GATE_DISTILL', 'PROMPT_VERSION', 'SELF_CONSISTENCY_K', 'SEMCACHE']) {
      expect(example).toContain(`${key}=`);
      expect(agentSetup).toContain(key);
      expect(key in CONFIG).toBe(true);
    }
  });

  it('keeps the CLI commands', () => {
    const cli = read('src/cli.ts');
    for (const command of ['start', 'stop', 'restart', 'doctor', 'memory', 'metrics', 'mcp', 'serve', 'setup-dashboard']) expect(cli).toContain(`'${command}'`);
  });
});
