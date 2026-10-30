/**
 * @fileoverview What the conditioning pipeline does besides distilling: grounding and the resolver run only
 * for a result large enough to distil; the repository index is refreshed off the request path, once per
 * workspace; a file the brain names as evidence is read only inside the workspace.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '', LANGFUSE_HOST: '', LANGFUSE_ENVIRONMENT: 'test',
    OLLAMA_HOST: 'http://fake',
    PROMPT_VERSION: 'gating',
    DISTILL_MIN_TOKENS: 50, DISTILL_MAX_TOKENS: 2000, DISTILL_SKILLS: false,
    DISTILL_PRESERVE_MODE: 'extend', DISTILL_PRESERVE_PATH: null, TLS_ADAPTER: false,
    ELISION_RETENTION_DAYS: 180, ELISION_MAX_MB: 10,
    RESOLVER_PROMPT_TOKENS: 3000, REPO_INDEX: true, SEMCACHE: false, CONVERSATION_MEMORY: false,
    SLM_BRAIN_MODEL: 'brain', SLM_GATE_MODEL: 'gate', SLM_TIMEOUT_MS: 5000,
  },
}));
const resolveAmbiguities = jest.fn(async () => ({ autoApplied: [], askUser: [], dependencies: [], staleDecisions: [] }));
jest.unstable_mockModule('../../src/resolver/index.js', () => ({
  resolveAmbiguities,
  prepareSkillContext: (text: string) => ({ text, tokEst: 10, originalTokEst: 10, trimmed: false }),
}));
const scan = jest.fn(async () => '');
jest.unstable_mockModule('../../src/mcp-gate/ground.js', () => ({ scan }));
jest.unstable_mockModule('../../src/cache/index.js', () => ({ checkSemanticCache: async () => null, setSemanticCache: async () => undefined }));
jest.unstable_mockModule('../../src/models/slm.js', () => ({ SLM: class {} }));
const refreshRepoIndex = jest.fn(() => ({ revision: 1, files: 0, changed: 0, removed: 0 }));
jest.unstable_mockModule('../../src/index/repo-index.js', () => ({ refreshRepoIndex, existingCodeSection: () => '' }));

const { conditionPrompt, readWorkspaceLines } = await import('../../src/mcp-gate/pipeline.js');

const ROOT = '/repo/gating';
let n = 0;
const small = () => `# Skill ${++n}\nDo the thing.`;
const large = () => `# Skill ${++n}\n` + 'A line of instructions that carries enough words to be worth conditioning.\n'.repeat(6);

beforeEach(() => {
  resolveAmbiguities.mockClear();
  scan.mockClear();
});

describe('grounding and the resolver', () => {
  it('are skipped for a result under DISTILL_MIN_TOKENS', async () => {
    const text = small();
    const out = await conditionPrompt({ text: text, task: 'task', rootUri: `file://${ROOT}`, toolName: 'get_skill' });
    expect(out).toBe(text);
    expect(scan).not.toHaveBeenCalled();
    expect(resolveAmbiguities).not.toHaveBeenCalled();
  });

  it('run for a result at or over DISTILL_MIN_TOKENS', async () => {
    await conditionPrompt({ text: large(), task: 'task', rootUri: `file://${ROOT}`, toolName: 'get_skill' });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(resolveAmbiguities).toHaveBeenCalledTimes(1);
  });
});

describe('the repository index', () => {
  it('is refreshed once per workspace, not on every call', async () => {
    const before = refreshRepoIndex.mock.calls.length;
    await conditionPrompt({ text: large(), task: 'task', rootUri: `file://${ROOT}`, toolName: 'get_skill' });
    await conditionPrompt({ text: large(), task: 'task', rootUri: `file://${ROOT}`, toolName: 'get_skill' });
    expect(refreshRepoIndex.mock.calls.length - before).toBeLessThanOrEqual(1);
  });
});

describe('readWorkspaceLines', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src/a.ts'), 'line 1\nline 2\n');
  fs.writeFileSync(path.join(path.dirname(workspace), 'outside.txt'), 'secret\n');

  it('reads a file inside the workspace', async () => {
    expect(await readWorkspaceLines({ rootPath: workspace, pattern: 'src/a.ts' })).toEqual(['line 1', 'line 2', '']);
  });

  it('refuses a path that resolves outside the workspace', async () => {
    expect(await readWorkspaceLines({ rootPath: workspace, pattern: '../outside.txt' })).toEqual([]);
    expect(await readWorkspaceLines({ rootPath: workspace, pattern: path.join(path.dirname(workspace), 'outside.txt') })).toEqual([]);
  });
});
