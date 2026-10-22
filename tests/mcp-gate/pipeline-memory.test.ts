/**
 * @fileoverview The conditioning pipeline with conversation memory (slice 4): the resolver receives the usable
 * summary for the workspace and its Decided lines; the condition row says which memory matched; the cached
 * conditioning depends on the memory's fold time (a newer fold makes the next call a miss); an entry cached
 * without memory misses once memory exists; the semantic cache is skipped while a usable memory exists.
 * Real in-memory ledger; the distiller never runs (minimum tokens above the text); resolver, grounding and
 * semantic cache are fakes that record their calls.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    OLLAMA_HOST: 'http://fake',
    PROMPT_VERSION: 'pipe-mem',
    DISTILL_MIN_TOKENS: 100000, DISTILL_MAX_TOKENS: 2000, DISTILL_SKILLS: false,
    DISTILL_PRESERVE_MODE: 'extend', DISTILL_PRESERVE_PATH: null, TLS_ADAPTER: false,
    RESOLVER_PROMPT_TOKENS: 3000, REPO_INDEX: false, SEMCACHE: false,
    CONVERSATION_MEMORY: true, MEMORY_MATCH_WINDOW_MS: 600000,
    SLM_BRAIN_MODEL: 'brain', SLM_GATE_MODEL: 'gate', SLM_TIMEOUT_MS: 5000,
  },
}));
const resolveAmbiguities = jest.fn(async () => ({ autoApplied: [], askUser: [], dependencies: [], staleDecisions: [] }));
jest.unstable_mockModule('../../src/resolver/index.js', () => ({
  resolveAmbiguities,
  prepareSkillContext: (text: string) => ({ text, tokEst: 10, originalTokEst: 10, trimmed: false }),
}));
jest.unstable_mockModule('../../src/mcp-gate/ground.js', () => ({ scan: async () => '' }));
const checkSemanticCache = jest.fn(async () => null);
jest.unstable_mockModule('../../src/cache/index.js', () => ({ checkSemanticCache, setSemanticCache: async () => undefined }));
jest.unstable_mockModule('../../src/models/slm.js', () => ({ SLM: class {} }));

const { CONFIG } = await import('../../src/config.js');
const { conditionPrompt } = await import('../../src/mcp-gate/pipeline.js');
const { getDb, writeMemoryRow } = await import('../../src/ledger/index.js');

const ROOT = '/repo/mem';
const summary = (goal: string) => JSON.stringify({ goal, decided: ['Use Jest'], inPlay: [] });
const future = (plusMs = 60_000) => new Date(Date.now() + plusMs).toISOString();
const row = (over: Record<string, unknown> = {}) => writeMemoryRow({
  key: 'conv1', root: ROOT, summary: summary('Ship it'), turns: 3, discriminator: null,
  started_at: future(), folded_at: future(), fold_count: 1, fold_ms: 5, prompt_version: 'pipe-mem', ...over,
} as any);
const lastMeta = () => JSON.parse((getDb().prepare("SELECT meta FROM events WHERE route='condition' ORDER BY rowid DESC LIMIT 1").get() as { meta: string }).meta);
let n = 0;
const skill = () => `# Skill ${++n}\nDo the thing.`;

beforeEach(() => {
  getDb().prepare('DELETE FROM conversation_memory').run();
  getDb().prepare('DELETE FROM condition_deps').run();
  resolveAmbiguities.mockClear();
  checkSemanticCache.mockClear();
  (CONFIG as any).SEMCACHE = false;
});

describe('conditioning with conversation memory', () => {
  it('hands the resolver the summary and its Decided lines, records the match, and depends on the fold time', async () => {
    row();
    await conditionPrompt(skill(), 'task', `file://${ROOT}`, 'get_skill');
    const input = (resolveAmbiguities.mock.calls[0] as any[])[2];
    expect(input.conversation).toContain('Goal: Ship it');
    expect(input.decided).toEqual(['Use Jest']);
    expect(lastMeta().memory).toEqual({ match: 'root-recent' });
    const deps = getDb().prepare("SELECT path FROM condition_deps WHERE path LIKE 'memory:%'").all() as { path: string }[];
    expect(deps.map(d => d.path)).toEqual(['memory:conv1']);
  });

  it('serves the cached conditioning while the memory is unchanged, and recomputes after a newer fold', async () => {
    row();
    const text = skill();
    await conditionPrompt(text, 'task', `file://${ROOT}`, 'get_skill');
    await conditionPrompt(text, 'task', `file://${ROOT}`, 'get_skill');
    expect(resolveAmbiguities).toHaveBeenCalledTimes(1);
    row({ folded_at: future(120_000), fold_count: 2, summary: summary('Ship it, then test') });
    await conditionPrompt(text, 'task', `file://${ROOT}`, 'get_skill');
    expect(resolveAmbiguities).toHaveBeenCalledTimes(2);
    expect(((resolveAmbiguities.mock.calls[1] as any[])[2]).conversation).toContain('then test');
  });

  it('does not serve an entry cached without memory once a usable memory exists', async () => {
    const text = skill();
    await conditionPrompt(text, 'task', `file://${ROOT}`, 'get_skill');
    expect(lastMeta().memory).toEqual({ match: 'none' });
    row();
    await conditionPrompt(text, 'task', `file://${ROOT}`, 'get_skill');
    expect(resolveAmbiguities).toHaveBeenCalledTimes(2);
    expect(lastMeta().memory).toEqual({ match: 'root-recent' });
  });

  it('skips the semantic cache while a usable memory exists, and uses it otherwise', async () => {
    (CONFIG as any).SEMCACHE = true;
    row();
    await conditionPrompt(skill(), 'task', `file://${ROOT}`, 'get_skill');
    expect(checkSemanticCache).not.toHaveBeenCalled();
    getDb().prepare('DELETE FROM conversation_memory').run();
    await conditionPrompt(skill(), 'task', `file://${ROOT}`, 'get_skill');
    expect(checkSemanticCache).toHaveBeenCalledTimes(1);
  });
});
