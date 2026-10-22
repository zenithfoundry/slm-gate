/**
 * @fileoverview Repository symbol index (slice 8): identifier splitting, symbol extraction for TypeScript, Python
 * and Go, the non-git walk that skips build folders, incremental refresh by mtime with a revision that moves
 * only on change, plain-language lookup, and the resolver answering from index evidence with the index as its
 * cache dependency. Real ledger (this worker's file), fake brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SLM } from '../../src/models/slm.js';

// The real config object is frozen; a mock lets the resolver tests flip REPO_INDEX. Only the keys the ledger
// and the resolver read are needed.
jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    REPO_INDEX: false,
    SLM_BRAIN_MODEL: 'brain-under-test',
    SLM_GATE_MODEL: 'gate-under-test',
    SLM_TIMEOUT_MS: 5000,
    SELF_CONSISTENCY_K: 1,
    SELF_CONSISTENCY_TEMP: 0,
    RESOLVER_CLOUD_TIER: false,
    RESOLVER_CLOUD_BUDGET_USD: 0,
  },
}));

const { CONFIG } = await import('../../src/config.js');
const { existingCodeSection, extractSymbols, findExisting, identifierWords, listRepoFiles, refreshRepoIndex } = await import('../../src/index/repo-index.js');
const { resolveAmbiguities } = await import('../../src/resolver/index.js');

let repo: string;
/** Writes a file under the temp repo (creating folders) and returns its absolute path. */
const write = (rel: string, text: string) => {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-index-'));
  write('src/dashboard.ts', [
    'export function renderDashboard(data: Data): string {',
    '  return "";',
    '}',
    'export class ReportBuilder {',
    '  build(rows: Row[]): Report {',
    '    if (rows.length === 0) {',
    '      return empty;',
    '    }',
    '    return rows;',
    '  }',
    '}',
    'export const makeThing = async (x: number) => x;',
    'export interface Data { rows: Row[] }',
    'export type Row = { id: string };',
  ].join('\n'));
  write('lib/totals.py', 'def compute_total(rows):\n    return sum(rows)\n\nclass Report:\n    pass\n');
  write('cmd/main.go', 'package main\n\nfunc (s *Server) HandleRequest(w http.ResponseWriter) {}\n\ntype Server struct{}\n');
  write('node_modules/dep/index.js', 'export function neverIndexed() {}\n');
  write('README.md', '# not source\n');
});
afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('identifier words', () => {
  it('splits camelCase, snake_case, kebab-case and acronyms into lower-case words', () => {
    expect(identifierWords('renderDashboard')).toBe('render dashboard');
    expect(identifierWords('compute_total')).toBe('compute total');
    expect(identifierWords('parse-HTTPResponse')).toBe('parse http response');
  });
});

describe('symbol extraction', () => {
  it('finds functions, classes, methods, arrow constants, interfaces and types in TypeScript, and skips control flow', () => {
    const symbols = extractSymbols('src/dashboard.ts', fs.readFileSync(path.join(repo, 'src/dashboard.ts'), 'utf8'));
    expect(symbols.map(s => `${s.kind}:${s.name}:${s.line}`)).toEqual([
      'function:renderDashboard:1', 'class:ReportBuilder:4', 'method:build:5', 'const:makeThing:12', 'interface:Data:13', 'type:Row:14',
    ]);
  });

  it('finds Python defs and classes, and Go funcs (including receivers) and types', () => {
    expect(extractSymbols('lib/totals.py', fs.readFileSync(path.join(repo, 'lib/totals.py'), 'utf8')).map(s => s.name)).toEqual(['compute_total', 'Report']);
    expect(extractSymbols('cmd/main.go', fs.readFileSync(path.join(repo, 'cmd/main.go'), 'utf8')).map(s => `${s.kind}:${s.name}`)).toEqual(['function:HandleRequest', 'type:Server']);
  });

  it('yields nothing for a file in an unsupported language', () => {
    expect(extractSymbols('README.md', '# title\nfunction notCode() {}')).toEqual([]);
  });
});

describe('the index of a repository', () => {
  it('lists only source files outside build folders when the root is not a git checkout', () => {
    expect(listRepoFiles(repo)).toEqual(['cmd/main.go', 'lib/totals.py', 'src/dashboard.ts']);
  });

  it('indexes every source file once, then only what changed, moving the revision only on change', () => {
    const first = refreshRepoIndex(repo, { force: true });
    expect(first).toMatchObject({ files: 3, changed: 3, removed: 0 });
    expect(first.revision).toBeGreaterThan(0);

    const again = refreshRepoIndex(repo, { force: true });
    expect(again).toMatchObject({ changed: 0, removed: 0, revision: first.revision });

    const file = path.join(repo, 'src/dashboard.ts');
    fs.appendFileSync(file, '\nexport function exportCsv(): void {}\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    const edited = refreshRepoIndex(repo, { force: true });
    expect(edited).toMatchObject({ changed: 1, removed: 0, revision: first.revision + 1 });

    fs.rmSync(path.join(repo, 'lib/totals.py'));
    const removed = refreshRepoIndex(repo, { force: true });
    expect(removed).toMatchObject({ files: 2, changed: 0, removed: 1, revision: first.revision + 2 });
  });

  it('finds a symbol from plain words, and the appended section names real paths', () => {
    refreshRepoIndex(repo, { force: true });
    expect(findExisting({ root: repo, query: 'render the dashboard' })[0]).toMatchObject({ name: 'renderDashboard', path: 'src/dashboard.ts', line: 1 });
    expect(findExisting({ root: repo, query: 'export csv' })[0]?.name).toBe('exportCsv');
    expect(findExisting({ root: repo, query: 'zzz qqq' })).toEqual([]);
    const section = existingCodeSection({ root: repo, task: 'build a report' });
    expect(section).toContain('# Existing code that may already cover this');
    expect(section).toContain('src/dashboard.ts:');
    expect(existingCodeSection({ root: repo, task: 'zzz qqq' })).toBe('');
  });
});

describe('the resolver with index evidence (REPO_INDEX on)', () => {
  let slm: jest.Mocked<SLM>;
  const fsRead = jest.fn<(pattern: string) => Promise<string[]>>().mockResolvedValue(['{}']);
  const previous = CONFIG.REPO_INDEX;
  beforeEach(() => {
    slm = { generateJSON: jest.fn(), generateText: jest.fn(), streamText: jest.fn() } as any;
    fsRead.mockClear();
  });
  afterAll(() => {
    (CONFIG as any).REPO_INDEX = previous;
  });

  it('answers from the symbols the question names, cites them, and depends on the index revision', async () => {
    (CONFIG as any).REPO_INDEX = true;
    slm.generateJSON
      .mockResolvedValueOnce({ decisions: [{ id: 'q', question: 'Where is the dashboard rendered?', kind: 'code' }] })
      .mockResolvedValueOnce({ answer: 'In renderDashboard, src/dashboard.ts', options: [] })
      .mockResolvedValueOnce({ risk: 'low' });
    const out = await resolveAmbiguities(slm, fsRead, { skillText: 'skill', task: 'task', repoRoot: repo });
    expect(fsRead).not.toHaveBeenCalled();
    expect(out.autoApplied[0].answer).toContain('renderDashboard');
    const evidencePrompt = String(slm.generateJSON.mock.calls[1][1]);
    expect(evidencePrompt).toContain('src/dashboard.ts:1');
    expect(out.dependencies?.some(d => d.path === `index:${repo}` && d.mtime > 0)).toBe(true);
  });

  it('takes the file-pattern path as before when the index is off', async () => {
    (CONFIG as any).REPO_INDEX = false;
    slm.generateJSON
      .mockResolvedValueOnce({ decisions: [{ id: 'q', question: 'Where is the dashboard rendered?', kind: 'code' }] })
      .mockResolvedValueOnce({ patterns: ['package.json'] })
      .mockResolvedValueOnce({ answer: 'x', options: [] })
      .mockResolvedValueOnce({ risk: 'low' });
    await resolveAmbiguities(slm, fsRead, { skillText: 'skill', task: 'task', repoRoot: repo });
    expect(fsRead).toHaveBeenCalled();
  });
});
