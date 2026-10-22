/**
 * @fileoverview Decision memory: parsing and staleness of decision files, the FTS match on a
 * paraphrased question, and the resolver taking a verified decision through the risk gate as an auto-applied
 * answer with provenance (no file read), an unverified one as a recommendation, a destructive-risk one never,
 * and the evidence path when the confirmation call fails. Real ledger (this worker's file), fake brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SLM } from '../models/slm.js';
import { DECISIONS_DIR, isStale, isTrusted, loadDecisionMemory, parseDecisionFile } from './decisions.js';
import { resolveAmbiguities } from './index.js';
import { cacheDepsFresh, writeCacheDeps } from '../ledger/index.js';

const FILE = `---
type: Decision
title: Architecture direction
verified_by: human:bz3b
verified_at: 2026-10-21
stale_after: 2099-01-01
---
API-first. The primary product boundary is the MCP protocol and the wire formats.
`;

let repo: string;
/** Writes one decision file into the temp repo and returns its absolute path. */
const writeDecision = (name: string, text: string) => {
  const dir = path.join(repo, DECISIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'));
});
afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('decision files', () => {
  it('parses flat frontmatter and the body, and ignores a file without a title', () => {
    const parsed = parseDecisionFile({ absPath: '/r/.slm-gate/decisions/a.md', relPath: '.slm-gate/decisions/a.md', raw: FILE, mtime: 1234.6 });
    expect(parsed).toMatchObject({ title: 'Architecture direction', verifiedBy: 'human:bz3b', verifiedAt: '2026-10-21', staleAfter: '2099-01-01', mtime: 1235 });
    expect(parsed?.body).toContain('API-first.');
    expect(parseDecisionFile({ absPath: '/r/x.md', relPath: 'x.md', raw: '# just notes\n', mtime: 1 })).toBeNull();
  });

  it('treats a decision past stale_after as stale and not trusted; a human-verified current one as trusted', () => {
    const current = parseDecisionFile({ absPath: '/a', relPath: 'a', raw: FILE, mtime: 1 })!;
    const stale = { ...current, staleAfter: '2000-01-01' };
    const unverified = { ...current, verifiedBy: null };
    expect(isStale(current)).toBe(false);
    expect(isStale(stale)).toBe(true);
    expect(isTrusted(current)).toBe(true);
    expect(isTrusted(stale)).toBe(false);
    expect(isTrusted(unverified)).toBe(false);
  });
});

describe('decision memory of a repo', () => {
  beforeEach(() => {
    fs.rmSync(path.join(repo, '.slm-gate'), { recursive: true, force: true });
  });

  it('is empty for a repo without the folder, depending on the repo root so a folder created later is noticed', () => {
    const memory = loadDecisionMemory(repo);
    expect(memory.decisions).toHaveLength(0);
    expect(memory.dirDependency?.path).toBe(repo);
    expect(memory.match('API-first or UI-first?')).toBeNull();
  });

  it('prefers a current decision over a stale one that ranks higher on words', () => {
    writeDecision('old-architecture.md', FILE.replace('stale_after: 2099-01-01', 'stale_after: 2000-01-01').replace('API-first. The primary', 'API-first. The primary primary boundary boundary'));
    writeDecision('architecture-direction.md', FILE);
    const memory = loadDecisionMemory(repo);
    expect(memory.match('Which boundary is the primary product boundary?')?.relPath).toBe(path.join(DECISIONS_DIR, 'architecture-direction.md'));
  });

  it('matches a paraphrased question to the decision and records the folder as a dependency', () => {
    writeDecision('architecture-direction.md', FILE);
    const memory = loadDecisionMemory(repo);
    expect(memory.decisions).toHaveLength(1);
    expect(memory.dirDependency?.path).toBe(path.join(repo, DECISIONS_DIR));
    expect(memory.match('Which boundary is the primary product boundary?')?.title).toBe('Architecture direction');
    expect(memory.match('How many retries on a flaky socket?')).toBeNull();
  });

  it('skips a stale decision and reports it', () => {
    writeDecision('old.md', FILE.replace('stale_after: 2099-01-01', 'stale_after: 2000-01-01'));
    const memory = loadDecisionMemory(repo);
    expect(memory.stale).toEqual([path.join(DECISIONS_DIR, 'old.md')]);
    expect(memory.match('Which boundary is primary?')).toBeNull();
  });
});

describe('the resolver with decision memory', () => {
  const question = { id: 'q1', question: 'Is this repository API-first or UI-first?', kind: 'architecture' };
  let slm: jest.Mocked<SLM>;
  let fsRead: jest.Mock<(pattern: string) => Promise<string[]>>;

  beforeEach(() => {
    fs.rmSync(path.join(repo, '.slm-gate'), { recursive: true, force: true });
    slm = { generateJSON: jest.fn(), generateText: jest.fn(), streamText: jest.fn() } as any;
    fsRead = jest.fn<(pattern: string) => Promise<string[]>>().mockResolvedValue(['{"name":"x"}']);
  });

  it('auto-applies a verified, low-risk decision with provenance and reads no file', async () => {
    writeDecision('architecture-direction.md', FILE);
    slm.generateJSON
      .mockResolvedValueOnce({ decisions: [question] })                       // extract
      .mockResolvedValueOnce({ applies: true, answer: 'API-first.' })        // decision confirms
      .mockResolvedValueOnce({ risk: 'low' });                                // risk gate
    const out = await resolveAmbiguities(slm, fsRead, { skillText: 'skill', task: 'task', repoRoot: repo });
    expect(out.autoApplied).toHaveLength(1);
    expect(out.autoApplied[0].answer).toBe('API-first.');
    expect(out.autoApplied[0].provenance).toContain('decision: .slm-gate/decisions/architecture-direction.md (verified by human:bz3b 2026-10-21)');
    expect(fsRead).not.toHaveBeenCalled();
    expect(out.dependencies?.map(d => path.basename(d.path))).toEqual(['decisions', 'architecture-direction.md']);
    expect(out.dependencies?.[1].expiresAt).toBe('2099-01-01');
  });

  it('offers an unverified decision as a recommendation, never auto-applied', async () => {
    writeDecision('architecture-direction.md', FILE.replace('verified_by: human:bz3b\n', ''));
    slm.generateJSON
      .mockResolvedValueOnce({ decisions: [question] })
      .mockResolvedValueOnce({ applies: true, answer: 'API-first.' })
      .mockResolvedValueOnce({ risk: 'low' });
    const out = await resolveAmbiguities(slm, fsRead, { skillText: 'skill', task: 'task', repoRoot: repo });
    expect(out.autoApplied).toHaveLength(0);
    expect(out.askUser[0].recommendedAnswer).toBe('API-first.');
    expect(out.askUser[0].provenance).toContain('unverified');
  });

  it('never auto-applies a decision for a destructive-risk question', async () => {
    writeDecision('architecture-direction.md', FILE);
    slm.generateJSON
      .mockResolvedValueOnce({ decisions: [question] })
      .mockResolvedValueOnce({ applies: true, answer: 'Drop it.' })
      .mockResolvedValueOnce({ risk: 'destructive' });
    const out = await resolveAmbiguities(slm, fsRead, { skillText: 'skill', task: 'task', repoRoot: repo });
    expect(out.autoApplied).toHaveLength(0);
    expect(out.askUser).toHaveLength(1);
  });

  it('falls back to the evidence path when the confirmation call fails', async () => {
    writeDecision('architecture-direction.md', FILE);
    slm.generateJSON
      .mockResolvedValueOnce({ decisions: [question] })
      .mockRejectedValueOnce(new Error('timed out'))                           // decision confirm fails
      .mockResolvedValueOnce({ patterns: ['package.json'] })                   // evidence patterns
      .mockResolvedValueOnce({ answer: 'API-first', options: [] })             // evidence answer
      .mockResolvedValueOnce({ risk: 'low' });
    const out = await resolveAmbiguities(slm, fsRead, { skillText: 'skill', task: 'task', repoRoot: repo });
    expect(fsRead).toHaveBeenCalled();
    expect(out.autoApplied[0].provenance).toBeUndefined();
  });

  it('behaves exactly as before for a repo without the folder', async () => {
    slm.generateJSON
      .mockResolvedValueOnce({ decisions: [question] })
      .mockResolvedValueOnce({ patterns: ['package.json'] })
      .mockResolvedValueOnce({ answer: 'API-first', options: [] })
      .mockResolvedValueOnce({ risk: 'low' });
    const out = await resolveAmbiguities(slm, fsRead, { skillText: 'skill', task: 'task', repoRoot: repo });
    expect(fsRead).toHaveBeenCalled();
    // The only dependency is the repo root, so a decisions folder created later is noticed.
    expect(out.dependencies?.map(d => d.path)).toEqual([repo]);
    expect(out.staleDecisions).toEqual([]);
  });
});

describe('conditioning cache dependencies', () => {
  it('serves a hit while the files are unchanged, and not after an edit, a removal or an expiry', () => {
    const file = writeDecision('dep.md', FILE);
    const mtime = Math.round(fs.statSync(file).mtimeMs);
    writeCacheDeps('condition_test', [{ path: file, mtime, expiresAt: '2099-01-01' }]);
    expect(cacheDepsFresh('condition_test')).toBe(true);
    expect(cacheDepsFresh('condition_test', { now: new Date('2100-01-01') })).toBe(false);
    expect(cacheDepsFresh('condition_test', { statMtime: () => mtime + 1000 })).toBe(false);
    fs.rmSync(file);
    expect(cacheDepsFresh('condition_test')).toBe(false);
    expect(cacheDepsFresh('condition_without_deps')).toBe(true);
  });

  it('answers a pseudo-path such as the repo index revision from the caller, and real paths from the file system', () => {
    writeCacheDeps('condition_index', [{ path: 'index:/some/repo', mtime: 3, expiresAt: null }]);
    const resolve = (revision: number) => (p: string) => (p.startsWith('index:') ? revision : undefined);
    expect(cacheDepsFresh('condition_index', { statMtime: resolve(3) })).toBe(true);
    expect(cacheDepsFresh('condition_index', { statMtime: resolve(4) })).toBe(false);
  });
});
