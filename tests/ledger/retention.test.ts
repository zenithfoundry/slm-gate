/**
 * @fileoverview Ledger housekeeping: the startup sweep prunes every cached table past ELISION_RETENTION_DAYS,
 * an elision read stamps "last used" at most once a day, and a distill-policy pattern is matched literally
 * apart from its `%` wildcard.
 */
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: path.join(dir, 'ledger.sqlite'),
    LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '', LANGFUSE_HOST: '', LANGFUSE_ENVIRONMENT: 'test',
    ELISION_RETENTION_DAYS: 180,
    ELISION_MAX_MB: 10,
  },
}));

const { getDb, getDistillPolicy, getElision, LangfuseSink, writeElision } = await import('../../src/ledger/index.js');

const daysAgo = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
};

describe('startup sweep', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare('INSERT INTO cache (key, value, ts) VALUES (?, ?, ?)').run('old', 'v', daysAgo(181));
    db.prepare('INSERT INTO cache (key, value, ts) VALUES (?, ?, ?)').run('new', 'v', daysAgo(1));
    db.prepare('INSERT INTO llm_distilled (key, text, outcome, created_at) VALUES (?, ?, ?, ?)').run('old', 't', 'o', daysAgo(181));
    db.prepare('INSERT INTO llm_distilled (key, text, outcome, created_at) VALUES (?, ?, ?, ?)').run('new', 't', 'o', daysAgo(1));
    // Reopen: the sweep runs when the database is opened.
    LangfuseSink.__resetForTests();
  });

  it('prunes the conditioning cache and the model gate decisions past the retention window', () => {
    const db = getDb();
    expect(db.prepare('SELECT key FROM cache').pluck().all()).toEqual(['new']);
    expect(db.prepare('SELECT key FROM llm_distilled').pluck().all()).toEqual(['new']);
  });
});

describe('getElision', () => {
  const record = { id: 'touch', tool_name: 'tool', args: '{}', original_text: 'x', ranges: '[]', content_hash: 'h', size_bytes: 1 };
  const lastAccessed = () => getDb().prepare('SELECT last_accessed_at FROM elision_cache WHERE id = ?').pluck().get('touch') as string;

  it('leaves a fresh "last used" stamp alone and refreshes a day-old one', () => {
    writeElision(record);
    const recent = daysAgo(0);
    getDb().prepare('UPDATE elision_cache SET last_accessed_at = ? WHERE id = ?').run(recent, 'touch');
    getElision('touch');
    expect(lastAccessed()).toBe(recent);

    const stale = daysAgo(2);
    getDb().prepare('UPDATE elision_cache SET last_accessed_at = ? WHERE id = ?').run(stale, 'touch');
    getElision('touch');
    expect(lastAccessed()).not.toBe(stale);
  });
});

describe('getDistillPolicy', () => {
  it('treats everything but % in a pattern as literal', () => {
    const db = getDb();
    db.prepare('DELETE FROM distill_policy').run();
    db.prepare('INSERT INTO distill_policy (tool_pattern, fidelity, priority, updated_at) VALUES (?, ?, ?, ?)').run('read.file(%)', 'verbatim', 10, daysAgo(0));
    db.prepare('INSERT INTO distill_policy (tool_pattern, fidelity, priority, updated_at) VALUES (?, ?, ?, ?)').run('*', 'summarize', -1, daysAgo(0));

    expect(getDistillPolicy('read.file(v2)')).toBe('verbatim');
    // Before escaping, "." matched any character and "(" opened a group: this name matched too.
    expect(getDistillPolicy('readXfilev2')).toBe('summarize');
  });
});
