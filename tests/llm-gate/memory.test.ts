/**
 * @fileoverview Conversation memory, slice 1, without a local model: the history walk, the fold prefix (oldest
 * first, never skipped), the summary trim, one fold with a scripted brain writing the row with the cursor, a
 * failed fold leaving summary and cursor untouched and marking the row unusable, the debounce (two notes, one
 * fold), the idle gate (a fold waits for a request in flight), the fork on a shorter history, and the switch.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    CONVERSATION_MEMORY: true,
    MEMORY_MAX_TOKENS: 400,
    MEMORY_FOLD_INPUT_TOKENS: 3000,
    MEMORY_FOLD_INTERVAL_MS: 30,
    MEMORY_MATCH_WINDOW_MS: 600000,
    PROMPT_VERSION: 'mem-test',
    SLM_BRAIN_MODEL: 'brain', SLM_GATE_MODEL: 'gate', SLM_TIMEOUT_MS: 5000,
    SLM_PROVIDER: 'ollama', OLLAMA_HOST: 'http://localhost:11434',
  },
}));

const { CONFIG } = await import('../../src/config.js');
const { historyEntries } = await import('../../src/llm-gate/formats/anthropic.js');
const { conversationKey, conversationDiscriminator } = await import('../../src/llm-gate/formats/contract.js');
const memory = await import('../../src/llm-gate/memory.js');
const busy = await import('../../src/models/busy.js');
const { readMemoryRow, matchMemory, getDb } = await import('../../src/ledger/index.js');

/** A scripted brain: `answer` is what each fold returns; `calls` records the prompts it saw. */
function scriptedBrain(answer: () => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    client: { generateJSON: async ({ prompt }: { prompt: string }) => { calls.push(prompt); return answer(); } } as any,
  };
}
const summaryA = { goal: 'Ship the memory feature', decided: ['Fold on the brain model'], inPlay: ['src/llm-gate/memory.ts'] };

const body = (userTexts: string[], withTool = false) => ({
  messages: userTexts.flatMap((t, i) => [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }, { type: 'text', text: t }] },
    ...(i < userTexts.length - 1 ? [{ role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }, ...(withTool ? [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} }] : [])] }] : []),
    ...(withTool && i < userTexts.length - 1 ? [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(500) }] }] : []),
  ]),
});

beforeEach(() => {
  memory.resetMemoryQueue();
  getDb().prepare('DELETE FROM conversation_memory').run();
  (CONFIG as any).CONVERSATION_MEMORY = true;
  (CONFIG as any).SLM_PROVIDER = 'ollama';
  (CONFIG as any).OLLAMA_HOST = 'http://localhost:11434';
});
afterEach(() => memory.useMemoryClient(null));

describe('history entries', () => {
  it('lists typed user text, assistant text and shortened tool results in order, skipping injected blocks', () => {
    const entries = historyEntries(body(['first question', 'second question'], true));
    expect(entries.map(e => e.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(entries[0].text).toBe('first question');
    expect(entries[2].text.startsWith('Bash: xxxx')).toBe(true);
    expect(entries[2].text.length).toBeLessThanOrEqual('Bash: '.length + 200);
  });

  it('keys a conversation on its first user entry and tells a fork apart by the second', () => {
    expect(conversationKey(body(['a', 'b']))).toBe(conversationKey(body(['a', 'c'])));
    expect(conversationDiscriminator(body(['a']))).toBeNull();
    expect(conversationDiscriminator(body(['a', 'b']))).not.toBe(conversationDiscriminator(body(['a', 'c'])));
  });
});

describe('fold prefix and trim', () => {
  it('reads the oldest entries first and stops at the budget without skipping any', () => {
    const fresh = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, text: `entry ${i} ${'word '.repeat(100)}` }));
    const { count, text } = memory.foldPrefix(fresh, 300);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
    expect(text).toContain('entry 0');
    expect(text).not.toContain(`entry ${count}`);
  });

  it('cuts a single over-budget entry rather than skipping it, to within the budget by the same estimator', async () => {
    const { estimateTokens } = await import('../../src/utils/elision.js');
    const { count, text } = memory.foldPrefix([{ role: 'user', text: 'word '.repeat(5000) }], 100);
    expect(count).toBe(1);
    expect(estimateTokens(text) + 1).toBeLessThanOrEqual(100);
  });

  it('drops in-play lines first, then the oldest decided lines, to fit the token limit', () => {
    const big = { goal: 'g', decided: Array.from({ length: 8 }, (_, i) => `decision ${i} ${'w '.repeat(60)}`), inPlay: Array.from({ length: 12 }, (_, i) => `file ${i}`) };
    const trimmed = memory.trimSummary(big, 120);
    expect(trimmed.inPlay).toEqual([]);
    expect(trimmed.decided.length).toBeLessThan(8);
    expect(trimmed.decided[trimmed.decided.length - 1]).toContain('decision 7');
  });
});

describe('one fold', () => {
  it('writes the row with the cursor at the last entry read, under the current version', async () => {
    const { client, calls } = scriptedBrain(async () => summaryA);
    memory.useMemoryClient(client);
    const b = body(['first question', 'second question']);
    const key = conversationKey(b);
    memory.noteTurn({ key, root: '/repo', discriminator: conversationDiscriminator(b), entries: historyEntries(b) });
    const row = await memory.foldConversation(key, { waitForIdle: false });
    expect(row?.turns).toBe(3);
    expect(row?.fold_count).toBe(1);
    expect(row?.root).toBe('/repo');
    expect(row?.prompt_version).toBe('mem-test');
    expect(JSON.parse(readMemoryRow(key)!.summary)).toEqual(summaryA);
    expect(calls[0]).toContain('(none yet)');
    expect(calls[0]).toContain('first question');
  });

  it('on the next fold reads only the new entries plus the previous summary', async () => {
    const { client, calls } = scriptedBrain(async () => summaryA);
    memory.useMemoryClient(client);
    const b1 = body(['first question', 'second question']);
    const key = conversationKey(b1);
    memory.noteTurn({ key, root: '/repo', discriminator: null, entries: historyEntries(b1) });
    await memory.foldConversation(key, { waitForIdle: false });
    const b2 = body(['first question', 'second question', 'third question']);
    memory.noteTurn({ key, root: '/repo', discriminator: conversationDiscriminator(b2), entries: historyEntries(b2) });
    const row = await memory.foldConversation(key, { waitForIdle: false });
    expect(row?.turns).toBe(5);
    expect(calls[1]).toContain('Ship the memory feature');
    expect(calls[1]).toContain('third question');
    expect(calls[1]).not.toContain('[user] first question');
  });

  it('leaves summary and cursor untouched after a failed fold, marks the row failed, and readers ignore it until a good fold', async () => {
    const good = scriptedBrain(async () => summaryA);
    memory.useMemoryClient(good.client);
    const b1 = body(['first question', 'second question']);
    const key = conversationKey(b1);
    memory.noteTurn({ key, root: '/repo', discriminator: null, entries: historyEntries(b1) });
    await memory.foldConversation(key, { waitForIdle: false });
    const before = readMemoryRow(key)!;
    expect(matchMemory({ key }).match).toBe('key');

    memory.useMemoryClient(scriptedBrain(async () => { throw new Error('model unavailable'); }).client);
    const b2 = body(['first question', 'second question', 'third question']);
    memory.noteTurn({ key, root: '/repo', discriminator: null, entries: historyEntries(b2) });
    await memory.foldConversation(key, { waitForIdle: false });
    const after = readMemoryRow(key)!;
    expect(after.summary).toBe(before.summary);
    expect(after.turns).toBe(before.turns);
    expect(after.fold_failed_at! >= after.folded_at).toBe(true);
    expect(matchMemory({ key }).match).toBe('none');
    expect(memory.isPending(key)).toBe(true);

    memory.useMemoryClient(good.client);
    await memory.foldConversation(key, { waitForIdle: false });
    expect(readMemoryRow(key)!.fold_failed_at).toBeNull();
    expect(matchMemory({ key }).match).toBe('key');
  });

  it('starts a fresh row when a shorter history arrives under the same opening (a fork)', async () => {
    memory.useMemoryClient(scriptedBrain(async () => summaryA).client);
    const long = body(['same opening', 'b', 'c']);
    const key = conversationKey(long);
    memory.noteTurn({ key, root: null, discriminator: conversationDiscriminator(long), entries: historyEntries(long) });
    await memory.foldConversation(key, { waitForIdle: false });
    const other = body(['same opening', 'z']);
    memory.noteTurn({ key, root: null, discriminator: conversationDiscriminator(other), entries: historyEntries(other) });
    const row = await memory.foldConversation(key, { waitForIdle: false });
    expect(row?.key).toBe(`${key}:${conversationDiscriminator(other)}`);
    expect(readMemoryRow(key)!.turns).toBe(5);
    // Keyed matching resolves the fork for the forked conversation and the base row for the original.
    const forkMatch = matchMemory({ key, discriminator: conversationDiscriminator(other) });
    expect(forkMatch.match).toBe('key');
    expect(forkMatch.row?.key).toBe(`${key}:${conversationDiscriminator(other)}`);
    expect(matchMemory({ key, discriminator: conversationDiscriminator(long) }).row?.key).toBe(key);
  });

  it('never overwrites the stored row when a shorter history arrives with no second entry to tell it apart', async () => {
    memory.useMemoryClient(scriptedBrain(async () => summaryA).client);
    const long = body(['same opening', 'b', 'c']);
    const key = conversationKey(long);
    memory.noteTurn({ key, root: null, discriminator: conversationDiscriminator(long), entries: historyEntries(long) });
    await memory.foldConversation(key, { waitForIdle: false });
    const before = readMemoryRow(key)!;
    const single = body(['same opening']);
    memory.noteTurn({ key, root: null, discriminator: null, entries: historyEntries(single) });
    await memory.foldConversation(key, { waitForIdle: false });
    expect(readMemoryRow(key)).toEqual(before);
  });
});

describe('debounce, idle gate and the switch', () => {
  it('two notes inside the interval cause one fold covering both', async () => {
    const { client, calls } = scriptedBrain(async () => summaryA);
    memory.useMemoryClient(client);
    const key = conversationKey(body(['q']));
    memory.noteTurn({ key, root: null, discriminator: null, entries: historyEntries(body(['q'])) });
    memory.noteTurn({ key, root: null, discriminator: null, entries: historyEntries(body(['q', 'r'])) });
    await new Promise(r => setTimeout(r, 120));
    expect(calls).toHaveLength(1);
    expect(readMemoryRow(key)!.turns).toBe(3);
  });

  it('waits for a request in flight before folding', async () => {
    const { client, calls } = scriptedBrain(async () => summaryA);
    memory.useMemoryClient(client);
    const key = conversationKey(body(['q']));
    memory.noteTurn({ key, root: null, discriminator: null, entries: historyEntries(body(['q'])) });
    const done = busy.beginRequest();
    await new Promise(r => setTimeout(r, 120));
    expect(calls).toHaveLength(0);
    done();
    await new Promise(r => setTimeout(r, 50));
    expect(calls).toHaveLength(1);
  });

  it('notes nothing and folds nothing when the switch is off, and readers see no stored row', async () => {
    memory.useMemoryClient(scriptedBrain(async () => summaryA).client);
    const key = conversationKey(body(['q']));
    memory.noteTurn({ key, root: null, discriminator: null, entries: historyEntries(body(['q'])) });
    await memory.foldConversation(key, { waitForIdle: false });
    (CONFIG as any).CONVERSATION_MEMORY = false;
    memory.noteTurn({ key, root: null, discriminator: null, entries: historyEntries(body(['q', 'r'])) });
    expect(memory.isPending(key)).toBe(false);
    expect(matchMemory({ key }).match).toBe('none');
  });
});

describe('conversation text never leaves the machine', () => {
  it('folds only when the brain is the Ollama provider on a loopback host', () => {
    expect(memory.brainIsLocal()).toBe(true);
    (CONFIG as any).OLLAMA_HOST = 'http://127.0.0.1:11434'; expect(memory.brainIsLocal()).toBe(true);
    (CONFIG as any).OLLAMA_HOST = 'http://[::1]:11434'; expect(memory.brainIsLocal()).toBe(true);
    (CONFIG as any).OLLAMA_HOST = 'http://gpu-box.lan:11434'; expect(memory.brainIsLocal()).toBe(false);
    (CONFIG as any).OLLAMA_HOST = 'http://localhost:11434'; (CONFIG as any).SLM_PROVIDER = 'openai'; expect(memory.brainIsLocal()).toBe(false);
  });

  it('notes nothing when the brain is not local, even with the feature on', () => {
    (CONFIG as any).OLLAMA_HOST = 'http://gpu-box.lan:11434';
    const key = conversationKey(body(['q']));
    memory.noteTurn({ key, root: null, discriminator: null, entries: historyEntries(body(['q'])) });
    expect(memory.isPending(key)).toBe(false);
  });

  it('records each fold as a ledger row with numbers only, and the first-seen time as started_at', async () => {
    memory.useMemoryClient(scriptedBrain(async () => summaryA).client);
    const b = body(['first question', 'second question']);
    const key = conversationKey(b);
    const before = new Date().toISOString();
    memory.noteTurn({ key, root: null, discriminator: null, entries: historyEntries(b) });
    await new Promise(r => setTimeout(r, 5));
    const row = await memory.foldConversation(key, { waitForIdle: false });
    expect(row!.started_at >= before && row!.started_at <= row!.folded_at).toBe(true);
    const ev = getDb().prepare("SELECT route, is_local_call, in_tok, out_tok, meta FROM events WHERE route='memory_fold' ORDER BY rowid DESC LIMIT 1").get() as any;
    expect(ev.is_local_call).toBe(1);
    expect(ev.in_tok).toBeGreaterThan(0);
    expect(JSON.parse(ev.meta)).toMatchObject({ type: 'memory_fold', outcome: 'ok', turns: 3 });
    expect(ev.meta).not.toContain('first question');
  });

  it('treats a different second entry with a longer history as a fork, not a continuation', async () => {
    memory.useMemoryClient(scriptedBrain(async () => summaryA).client);
    const a = body(['same opening', 'branch a']);
    const key = conversationKey(a);
    memory.noteTurn({ key, root: null, discriminator: conversationDiscriminator(a), entries: historyEntries(a) });
    await memory.foldConversation(key, { waitForIdle: false });
    const b = body(['same opening', 'branch b', 'and more', 'and more']);
    memory.noteTurn({ key, root: null, discriminator: conversationDiscriminator(b), entries: historyEntries(b) });
    const row = await memory.foldConversation(key, { waitForIdle: false });
    expect(row?.key).toBe(`${key}:${conversationDiscriminator(b)}`);
    expect(readMemoryRow(key)!.turns).toBe(3);
  });
});
