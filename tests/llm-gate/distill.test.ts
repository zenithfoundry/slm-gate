import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// Short budget so the timeout path is quick; must be set before config is imported.
process.env.DISTILL_BUDGET_MS = '200';

const { distilRequest, commandOf, isFileReadCommand } = await import('../../src/llm-gate/distill.js');
const anthropic = await import('../../src/llm-gate/formats/anthropic.js');
const chatCompletions = await import('../../src/llm-gate/formats/chat-completions.js');
const responses = await import('../../src/llm-gate/formats/responses.js');
const gemini = await import('../../src/llm-gate/formats/gemini.js');
const { getDb } = await import('../../src/ledger/index.js');
const { formatElisionMarker, rewriteElisionHint } = await import('../../src/utils/elision.js');

type Engine = NonNullable<Parameters<typeof distilRequest>[0]['engine']>;

// Comfortably above DISTILL_MIN_TOKENS (500 tokens at ~3.5 chars each).
const big = (label: string) => Array.from({ length: 120 }, (_, i) => `${label} line ${i}: some ordinary output text here`).join('\n');

interface Turn {
  name: string;
  input: Record<string, unknown>;
  output: string;
}

/** An Anthropic conversation: one tool call and its result per turn; the last result is the new turn. */
function conversation(params: { first: string; turns: Turn[]; tools?: string[] }) {
  const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: params.first }] }];
  params.turns.forEach((turn, i) => {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${i}`, name: turn.name, input: turn.input }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: turn.output }] });
  });
  return { model: 'claude-sonnet-5', tools: (params.tools ?? ['Bash']).map(name => ({ name })), messages };
}

let firstCounter = 0;
/** A first message nobody else uses, so each test starts a fresh conversation. */
const fresh = () => `task ${++firstCounter} ${Date.now()}`;

const engineReturning = (make: (text: string) => string) =>
  jest.fn<Engine>(async ({ text }) => make(text));

async function run(body: any, engine: Engine) {
  const result = await distilRequest({ format: anthropic, body, engine });
  return { ...result, sent: result.body ?? body };
}

function toolResultText(body: any, turn: number): string {
  return body.messages[2 + turn * 2].content[0].content;
}

beforeEach(() => {
  const db = getDb();
  db.exec('DROP TRIGGER IF EXISTS fail_distill_insert');
});

describe('which tool results are distilled', () => {
  it('distils a large new command result and nothing else in the request', async () => {
    const body = conversation({ first: fresh(), turns: [{ name: 'Bash', input: { command: 'npm test' }, output: big('test') }] });
    const engine = engineReturning(() => 'DISTILLED');

    const { sent, stats } = await run(body, engine);

    expect(toolResultText(sent, 0)).toBe('DISTILLED');
    expect(JSON.stringify(sent)).toBe(JSON.stringify(body).replace(JSON.stringify(big('test')), '"DISTILLED"'));
    expect(engine).toHaveBeenCalledWith(expect.objectContaining({ kind: 'command', toolName: 'Bash' }));
    expect(stats).toMatchObject({ candidates: 1, distilled: 1 });
  });

  it('never distils file reads, unknown tools or small results', async () => {
    const engine = engineReturning(() => 'DISTILLED');
    for (const turn of [
      { name: 'Read', input: { file_path: 'a.ts' }, output: big('file') },
      { name: 'mcp__docs__search', input: {}, output: big('mcp') },
      { name: 'Bash', input: { command: 'cat src/a.ts' }, output: big('cat') },
      { name: 'Bash', input: { command: 'npm test' }, output: 'short output' },
    ]) {
      const { body } = await run(conversation({ first: fresh(), turns: [turn] }), engine);
      expect(body).toBeNull();
    }
    expect(engine).not.toHaveBeenCalled();
  });

  it('recognises commands that print files, including wrapped and piped ones', () => {
    for (const command of [
      'cat a.ts', 'bash -lc "sed -n 1,200p src/x.ts"', "sh -c 'nl -ba a.ts'", 'cd src && head -50 y.ts', '/bin/cat a', 'ls -la | tail -20',
      'FOO=bar cat file.ts', 'NODE_ENV=test cat config.json', "sed -ne '1,5p' a.ts", 'env LANG=C head a.ts', 'find . -name "*.ts" | xargs cat',
      'nice -n 10 cat file.ts', 'sudo -u root cat /etc/hosts', 'find . -name "*.ts" | xargs -I {} cat {}', 'xargs -0 cat', 'time -p cat build.log',
    ]) {
      expect(isFileReadCommand(command)).toBe(true);
    }
    // GIT_PAGER=cat prints a git log, not a file. Known gaps are asserted so a change in coverage is visible.
    for (const command of ['ls -la', 'npm test', 'git log --oneline', 'GIT_PAGER=cat git log', "awk '{print}' a.ts", 'python -c "print(open(\'a\').read())"', 'catalog.sh']) {
      expect(isFileReadCommand(command)).toBe(false);
    }
  });

  it('reads the command from string, argv and JSON-string arguments', () => {
    expect(commandOf({ command: 'ls' })).toBe('ls');
    expect(commandOf({ command: ['bash', '-lc', 'cat a'] })).toBe('bash -lc cat a');
    expect(commandOf({ cmd: 'tail x' })).toBe('tail x');
    expect(commandOf('{"command":"head y"}')).toBe('head y');
  });
});

describe('byte stability', () => {
  it('sends identical bytes when the same request is repeated, distilling only once', async () => {
    const body = conversation({ first: fresh(), turns: [{ name: 'Grep', input: { pattern: 'x' }, output: big('grep') }] });
    const engine = engineReturning(text => `DISTILLED ${text.length}`);

    const first = await run(body, engine);
    const second = await run(body, engine);

    expect(JSON.stringify(second.sent)).toBe(JSON.stringify(first.sent));
    expect(engine).toHaveBeenCalledTimes(1);
    expect(second.stats).toMatchObject({ reused: 1, distilled: 0 });
  });

  it('keeps an earlier distillation byte-identical when the conversation grows', async () => {
    const first = fresh();
    const engine = engineReturning(text => `DISTILLED ${text.length}`);
    const turn1 = { name: 'Bash', input: { command: 'npm run build' }, output: big('build') };
    const { sent } = await run(conversation({ first, turns: [turn1] }), engine);

    const later = await run(conversation({ first, turns: [turn1, { name: 'Glob', input: { pattern: '*' }, output: big('glob') }] }), engine);

    expect(toolResultText(later.sent, 0)).toBe(toolResultText(sent, 0));
    expect(toolResultText(later.sent, 1)).toMatch(/^DISTILLED/);
  });

  it('leaves history the provider already saw in full as it was, even once distilling is possible', async () => {
    // First sight of this result is as history: distilling was off, or the gate was not in the path.
    const first = fresh();
    const old = { name: 'Bash', input: { command: 'npm test' }, output: big('old') };
    const engine = engineReturning(() => 'DISTILLED');

    const { sent } = await run(conversation({ first, turns: [old, { name: 'Bash', input: { command: 'ls' }, output: 'small' }] }), engine);
    const later = await run(conversation({ first, turns: [old, { name: 'Bash', input: { command: 'ls' }, output: 'small' }, { name: 'Bash', input: { command: 'pwd' }, output: 'small' }] }), engine);

    expect(toolResultText(sent, 0)).toBe(big('old'));
    expect(toolResultText(later.sent, 0)).toBe(big('old'));
    expect(engine).not.toHaveBeenCalled();
  });

  it('does not share decisions between conversations', async () => {
    const output = big('shared');
    const engine = engineReturning(() => 'DISTILLED');
    const a = fresh();
    const b = fresh();
    // Conversation A saw it in full (history, no decision); conversation B meets it new.
    await run(conversation({ first: a, turns: [{ name: 'Bash', input: { command: 'git status' }, output }, { name: 'Bash', input: { command: 'ls' }, output: 'x' }] }), engine);
    const inB = await run(conversation({ first: b, turns: [{ name: 'Bash', input: { command: 'git status' }, output }] }), engine);
    const againA = await run(conversation({ first: a, turns: [{ name: 'Bash', input: { command: 'git status' }, output }, { name: 'Bash', input: { command: 'ls' }, output: 'x' }] }), engine);

    expect(toolResultText(inB.sent, 0)).toBe('DISTILLED');
    expect(toolResultText(againA.sent, 0)).toBe(output);
  });

  it('shares one distillation between concurrent identical requests', async () => {
    const body = conversation({ first: fresh(), turns: [{ name: 'Grep', input: { pattern: 'y' }, output: big('concurrent') }] });
    const engine = jest.fn<Engine>(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return 'DISTILLED';
    });

    const [a, b] = await Promise.all([run(body, engine), run(body, engine)]);

    expect(engine).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(a.sent)).toBe(JSON.stringify(b.sent));
  });
});

describe('failures never change what was sent', () => {
  it('sends the original past the budget, and keeps sending it after the late result arrives', async () => {
    const body = conversation({ first: fresh(), turns: [{ name: 'Bash', input: { command: 'npm test' }, output: big('slow') }] });
    const engine = jest.fn<Engine>(async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
      return 'LATE';
    });

    const first = await run(body, engine);
    await new Promise(resolve => setTimeout(resolve, 700));
    const second = await run(body, engine);

    expect(first.body).toBeNull();
    expect(first.stats.timeouts).toBe(1);
    expect(second.body).toBeNull();
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it('sends the original when distillation throws, and does not retry it', async () => {
    const body = conversation({ first: fresh(), turns: [{ name: 'Bash', input: { command: 'make' }, output: big('broken') }] });
    const engine = jest.fn<Engine>(async () => { throw new Error('model unavailable'); });

    const first = await run(body, engine);
    const second = await run(body, engine);

    expect(first.body).toBeNull();
    expect(first.stats.errors).toBe(1);
    expect(second.body).toBeNull();
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it('sends the original when the decision cannot be stored, and still after a restart', async () => {
    const first = fresh();
    const turn = { name: 'Bash', input: { command: 'npm test' }, output: big('unstored') };
    const engine = engineReturning(() => 'DISTILLED');
    getDb().exec(`CREATE TRIGGER fail_distill_insert BEFORE INSERT ON llm_distilled BEGIN SELECT RAISE(ABORT, 'injected'); END;`);

    const whileFailing = await run(conversation({ first, turns: [turn] }), engine);
    getDb().exec('DROP TRIGGER fail_distill_insert');
    // Nothing in memory decides this: the next request (from this or a restarted gate) sees the result
    // as history with no stored decision, which can only mean the original was sent.
    const afterwards = await run(conversation({ first, turns: [turn, { name: 'Bash', input: { command: 'ls' }, output: 'x' }] }), engine);

    expect(toolResultText(whileFailing.sent, 0)).toBe(big('unstored'));
    expect(toolResultText(afterwards.sent, 0)).toBe(big('unstored'));
  });

  it('sends the original when stored decisions cannot be read', async () => {
    const db = getDb();
    db.exec('ALTER TABLE llm_distilled RENAME TO llm_distilled_hidden');
    try {
      const engine = engineReturning(() => 'DISTILLED');
      const { body } = await run(conversation({ first: fresh(), turns: [{ name: 'Bash', input: { command: 'npm test' }, output: big('unreadable') }] }), engine);
      expect(body).toBeNull();
      expect(engine).not.toHaveBeenCalled();
    } finally {
      db.exec('ALTER TABLE llm_distilled_hidden RENAME TO llm_distilled');
    }
  });
});

describe('elision markers', () => {
  const withMarker = () => `head\n${formatElisionMarker('abc', 40, 50, 89).trim()}\ntail`;

  it('points the model at re-running its tool when it has no expand_elision tool', async () => {
    const { sent } = await run(conversation({ first: fresh(), turns: [{ name: 'Bash', input: { command: 'npm test' }, output: big('m1') }] }), engineReturning(withMarker));
    expect(toolResultText(sent, 0)).not.toContain('expand_elision');
    expect(toolResultText(sent, 0)).toContain('re-run the tool with a narrower scope');
  });

  it('keeps the expand_elision hint when the client has that tool', async () => {
    const body = conversation({ first: fresh(), turns: [{ name: 'Bash', input: { command: 'npm test' }, output: big('m2') }], tools: ['Bash', 'mcp__slm-gate__expand_elision'] });
    const { sent } = await run(body, engineReturning(withMarker));
    expect(toolResultText(sent, 0)).toContain('call expand_elision with this id');
  });

  it('rewrites every form formatElisionMarker produces (fails if the wording drifts apart)', () => {
    for (const marker of [formatElisionMarker('abc', 10, 5, 14), formatElisionMarker('abc', 10)]) {
      const rewritten = rewriteElisionHint(marker);
      expect(rewritten).not.toBe(marker);
      expect(rewritten).not.toContain('expand_elision');
      expect(rewritten).toContain('10 lines elided');
    }
  });
});

/**
 * The same stability guarantees for the other three wire formats, with each conversation built the way
 * its clients send it (Chat Completions with a system message first, Codex-style Responses items,
 * Gemini CLI contents with thought signatures).
 */
let systemCounter = 0;

const OTHER_FORMATS = [
  {
    name: 'chat-completions',
    format: chatCompletions,
    build: (first: string, turns: Turn[]) => ({
      model: 'gpt-5.6-sol',
      messages: [
        // Deliberately different on every call: some clients regenerate the system message each turn,
        // which is why a conversation is identified by its first user message.
        { role: 'system', content: `system prompt ${++systemCounter}` },
        { role: 'user', content: first },
        ...turns.flatMap((turn, i) => [
          { role: 'assistant', content: null, tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: turn.name, arguments: JSON.stringify(turn.input) } }] },
          { role: 'tool', tool_call_id: `call_${i}`, content: turn.output },
        ]),
      ],
    }),
    textOf: (body: any, turn: number) => body.messages[3 + turn * 2].content,
  },
  {
    name: 'responses',
    format: responses,
    build: (first: string, turns: Turn[]) => ({
      model: 'gpt-5.6-codex',
      store: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: first }] },
        ...turns.flatMap((turn, i) => [
          { type: 'reasoning', id: `rs_${i}`, summary: [], encrypted_content: `ENC-${i}` },
          { type: 'function_call', call_id: `c${i}`, name: turn.name, arguments: JSON.stringify(turn.input) },
          { type: 'function_call_output', call_id: `c${i}`, output: turn.output },
        ]),
      ],
    }),
    textOf: (body: any, turn: number) => body.input[3 + turn * 3].output,
  },
  {
    name: 'gemini',
    format: gemini,
    build: (first: string, turns: Turn[]) => ({
      contents: [
        { role: 'user', parts: [{ text: first }] },
        ...turns.flatMap((turn, i) => [
          { role: 'model', parts: [{ functionCall: { id: `call_${i}`, name: turn.name, args: turn.input }, thoughtSignature: `SIG-${i}` }] },
          { role: 'user', parts: [{ functionResponse: { id: `call_${i}`, name: turn.name, response: { output: turn.output } } }] },
        ]),
      ],
    }),
    textOf: (body: any, turn: number) => body.contents[2 + turn * 2].parts[0].functionResponse.response.output,
  },
];

describe.each(OTHER_FORMATS)('byte stability in $name', ({ format, build, textOf }) => {
  const shell = (label: string): Turn => ({ name: 'run_shell_command', input: { command: `make ${label}` }, output: big(label) });
  const small = (label: string): Turn => ({ name: 'run_shell_command', input: { command: `echo ${label}` }, output: 'ok' });

  it('distils a new result once and resends identical bytes, also as the conversation grows', async () => {
    const first = fresh();
    const engine = engineReturning(text => `DISTILLED ${text.length}`);

    const once = await distilRequest({ format, body: build(first, [shell('a')]), engine });
    const again = await distilRequest({ format, body: build(first, [shell('a')]), engine });
    const grown = await distilRequest({ format, body: build(first, [shell('a'), small('b')]), engine });

    expect(textOf(once.body, 0)).toMatch(/^DISTILLED/);
    expect(textOf(again.body, 0)).toBe(textOf(once.body, 0));
    expect(textOf(grown.body, 0)).toBe(textOf(once.body, 0));
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it('leaves history the provider saw in full unchanged', async () => {
    const first = fresh();
    const engine = engineReturning(() => 'DISTILLED');

    const result = await distilRequest({ format, body: build(first, [shell('old'), small('now')]), engine });

    expect(result.body).toBeNull();
    expect(engine).not.toHaveBeenCalled();
  });
});
