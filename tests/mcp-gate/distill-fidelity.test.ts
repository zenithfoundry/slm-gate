/**
 * @fileoverview The skill-shrinking fidelity guard (slice 5), without a local model: a fake compressor that keeps
 * only each run's first sentence, and a scripted verifier. Proves (1) the deterministic classes survive by
 * construction and never reach the model, (2) the brain check fails closed on any missing sentence, wrong-length
 * answer, error, run cap or time budget, and (3) a skill still over budget after shrinking goes out as the original.
 * The fixtures in tests/fixtures/skills are generic skill-shaped documents, not toolbox text.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Small budgets so the fixtures (≈2,500 tokens each) reach summarize mode without a local model.
jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    DISTILL_PRESERVE_MODE: 'extend',
    DISTILL_PRESERVE_PATH: null,
    TLS_ADAPTER: false,
    DISTILL_MIN_TOKENS: 0,
    // Below the fixtures' size (≈5,700 tokens) so summarize runs, above their compressed size so nothing is cut.
    DISTILL_MAX_TOKENS: 4000,
    DISTILL_SKILLS: true,
    DISTILL_FIDELITY_MIN: 1.0,
    DISTILL_FIDELITY_MAX_RUNS: 8,
    DISTILL_FIDELITY_BUDGET_MS: 60_000,
    PROMPT_VERSION: 'fidelity-test',
    LEDGER_PATH: ':memory:',
  },
}));

const { CONFIG } = await import('../../src/config.js');
const { getDb } = await import('../../src/ledger/index.js');
const { buildPreserveList } = await import('../../src/utils/preserve-patterns.js');
const { distillToolResultWithStats, requirementInventory, fidelityTokens } = await import('../../src/utils/elision.js');
type Verify = import('../../src/utils/elision.js').FidelityVerify;

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'skills');
const fixtures = ['review-workflow', 'release-checklist', 'onboarding-guide'].map(name => ({
  name,
  text: fs.readFileSync(path.join(fixturesDir, `${name}.md`), 'utf8'),
  mustSurvive: JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.expected.json`), 'utf8')).mustSurvive as string[],
}));

// A compressor that keeps only the first sentence of each run: everything else is "lost" unless protected.
const firstSentence = jest.fn(async (text: string) => text.split(/(?<=[.!?])\s+/)[0]);
const allKept: Verify = async ({ inventory }) => inventory.map(() => true);
const patterns = await buildPreserveList();
let counter = 0;
// A distinct tool name per call keeps the distiller's own cache out of the way.
const distil = (text: string, opts: { verify?: Verify; skill?: boolean; slm?: typeof firstSentence } = {}) =>
  distillToolResultWithStats({
    slm: opts.slm ?? firstSentence, text, task: 'test', toolName: `${opts.skill ? 'get_skill' : 'notes'}-${++counter}`, args: {},
    preservePatterns: patterns, verify: opts.verify,
  });

beforeEach(() => {
  firstSentence.mockClear();
  // Learned protections persist in this suite's in-memory ledger; each test starts with none so an earlier
  // test's lesson cannot protect the lines a later test expects the compressor to see.
  getDb().prepare('DELETE FROM distill_protect').run();
  (CONFIG as any).DISTILL_FIDELITY_BUDGET_MS = 60_000;
  (CONFIG as any).DISTILL_FIDELITY_MAX_RUNS = 8;
  (CONFIG as any).DISTILL_MAX_TOKENS = 4000;
  console.warn = jest.fn();
  console.error = jest.fn();
});

describe('deterministic classes survive by construction (fixtures)', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name}: every must-survive line is in the output and was never shown to the model`, async () => {
      const { text, fidelity } = await distil(fixture.text, { verify: allKept });
      const shown = firstSentence.mock.calls.map(c => c[0]).join('\n');
      expect(fidelity.mode).toBe('summarize');
      expect(fidelity.deterministic).toBe(1);
      expect(fidelity.runs).toBeGreaterThan(0);
      for (const line of fixture.mustSurvive) {
        expect(text).toContain(line);
        expect(shown).not.toContain(line);
      }
      expect(text.length).toBeLessThan(fixture.text.length);
    });
  }

  it('protects the whole frontmatter block, not only its fence lines', async () => {
    const body = ['---', 'name: demo', 'list:', '  - an item that matches no preserve pattern', '---', '', '# Demo', '', fixtures[0].text.split('\n').slice(8).join('\n')].join('\n');
    const { text } = await distil(body, { verify: allKept });
    const shown = firstSentence.mock.calls.map(c => c[0]).join('\n');
    expect(text).toContain('  - an item that matches no preserve pattern');
    expect(shown).not.toContain('an item that matches no preserve pattern');
  });

  it('keeps the ORIGINAL, never the rebuilt text, when a tracked token goes missing (no preserve patterns, compressor drops everything)', async () => {
    const original = fixtures[0].text;
    const dropAll = jest.fn(async () => 'shortened.');
    const { text, fidelity } = await distillToolResultWithStats({
      slm: dropAll, text: original, task: 'test', toolName: `notes-${++counter}`, args: {}, preservePatterns: [], verify: allKept,
    });
    expect(dropAll).toHaveBeenCalled();
    expect(fidelity.deterministic).toBe(0);
    expect(fidelity.lost).toEqual(expect.arrayContaining(['mcp__example__open_change', '30 min']));
    expect(text).not.toContain('shortened.');
    expect(text.startsWith(original.split('\n').slice(0, 5).join('\n'))).toBe(true);
  });

  it('lists tool names and unit quantities as tracked tokens', () => {
    expect(fidelityTokens('call mcp__a__b, then wait 30 min and 2 tokens')).toEqual(['mcp__a__b', '30 min', '2 tokens']);
  });
});

describe('the requirement inventory the brain checks against', () => {
  it('keeps sentences with a rule word, a number, a backticked token or a path, in order, once each', () => {
    const run = 'Background prose that explains history. You should run the checks before merging. It costs 3 calls. Use `foo` here. Edit src/a/b.ts next. You should run the checks before merging.';
    expect(requirementInventory(run)).toEqual([
      'You should run the checks before merging.',
      'It costs 3 calls.',
      'Use `foo` here.',
      'Edit src/a/b.ts next.',
    ]);
  });
});

describe('model-judged recall, fail closed', () => {
  const doc = fixtures[1].text;
  const checkedRun = async (verify: Verify) => {
    const { text, fidelity } = await distil(doc, { verify });
    return { text, fidelity };
  };

  it('replaces a run when every inventory sentence is reported kept', async () => {
    const { fidelity } = await checkedRun(allKept);
    expect(fidelity.runsChecked).toBeGreaterThan(0);
    expect(fidelity.recall).toBe(1);
    expect(fidelity.runsKept).toBe(0);
  });

  it('keeps a run verbatim when one inventory sentence is reported missing', async () => {
    const dropFirst: Verify = async ({ inventory }) => inventory.map((_, i) => i !== 0);
    const { text, fidelity } = await checkedRun(dropFirst);
    expect(fidelity.runsKept).toBeGreaterThan(0);
    expect(fidelity.lost.length).toBeGreaterThan(0);
    for (const sentence of fidelity.lost) expect(text).toContain(sentence);
  });

  it('keeps a run verbatim when the checker returns the wrong number of answers', async () => {
    const short: Verify = async () => [true];
    const { fidelity } = await checkedRun(short);
    expect(fidelity.lost.some(l => l.startsWith('check_length_mismatch'))).toBe(true);
  });

  it('keeps every run verbatim when the checker fails', async () => {
    const broken: Verify = async () => { throw new Error('model unavailable'); };
    const { text, fidelity } = await checkedRun(broken);
    expect(fidelity.errors.some(l => l.startsWith('check_failed: model unavailable'))).toBe(true);
    // Every run the cap let through was checked, failed and kept; the rest were skipped by the cap.
    expect(fidelity.runsKept).toBe(fidelity.runs - fidelity.runsSkippedBudget);
    expect(fidelity.runsKept).toBeGreaterThan(0);
    // Nothing was shortened: the first prose paragraph is still there word for word.
    expect(text).toContain(doc.split('\n\n')[2]);
  });

  it('compresses at most DISTILL_FIDELITY_MAX_RUNS runs and leaves the rest verbatim', async () => {
    (CONFIG as any).DISTILL_FIDELITY_MAX_RUNS = 2;
    const { fidelity } = await checkedRun(allKept);
    expect(firstSentence).toHaveBeenCalledTimes(2);
    expect(fidelity.runsSkippedBudget).toBe(fidelity.runs - 2);
  });

  it('leaves runs verbatim once the document time budget is spent', async () => {
    (CONFIG as any).DISTILL_FIDELITY_BUDGET_MS = 1;
    const slow = jest.fn(async (text: string) => { await new Promise(r => setTimeout(r, 5)); return text.slice(0, 10); });
    const { text, fidelity } = await distil(doc, { verify: allKept, slm: slow });
    expect(fidelity.runsSkippedBudget).toBe(fidelity.runs);
    expect(text).toContain(doc.split('\n\n')[2]);
  });

  it('runs no check and applies no cap when no verifier is given (tool output path)', async () => {
    const { fidelity } = await distil(doc);
    expect(fidelity.runsChecked).toBe(0);
    expect(fidelity.recall).toBeNull();
    expect(fidelity.runs).toBeGreaterThan(8);
  });
});

describe('learned protections (slice 5b): a loss the brain reported once never recurs', () => {
  it('stores the missing sentences, then protects their lines on the next run without showing them to the model', async () => {
    const doc = fixtures[0].text;
    const dropFirst: Verify = async ({ inventory }) => inventory.map((_, i) => i !== 0);
    const first = await distil(doc, { verify: dropFirst });
    expect(first.fidelity.lost.length).toBeGreaterThan(0);
    expect(first.fidelity.learnedNew).toBeGreaterThan(0);

    firstSentence.mockClear();
    const second = await distil(doc, { verify: allKept });
    const shown = firstSentence.mock.calls.map(c => c[0]).join('\n').toLowerCase();
    expect(second.fidelity.learnedProtected).toBeGreaterThan(0);
    for (const sentence of first.fidelity.lost) expect(shown).not.toContain(sentence.toLowerCase());
    for (const sentence of first.fidelity.lost) expect(second.text).toContain(sentence);
  });
});

describe('a skill still over budget after shrinking is sent as the original (fail closed)', () => {
  it('reports not_shrunk, drops the compressed text and keeps the original head intact', async () => {
    // A budget the compressed text cannot meet either.
    (CONFIG as any).DISTILL_MAX_TOKENS = 400;
    const original = fixtures[2].text;
    const { text, fidelity } = await distil(original, { verify: allKept, skill: true });
    expect(fidelity.mode).toBe('not_shrunk');
    expect(text.startsWith(original.split('\n').slice(0, 5).join('\n'))).toBe(true);
    expect(text).toContain('lines elided [id:');
  });
});
