/**
 * @fileoverview The semantic cache: relative paths in a tool result are hashed against the workspace the
 * result came from (never slm-gate's own install directory), and rows past the retention window are
 * pruned when the cache is opened.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    LEDGER_PATH: ':memory:',
    LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '', LANGFUSE_HOST: '', LANGFUSE_ENVIRONMENT: 'test',
    ROOT_DIR: '/slm-gate/install',
    SEMCACHE: true, SEMCACHE_THRESHOLD: 0.95,
    ELISION_RETENTION_DAYS: 180,
  },
}));
jest.unstable_mockModule('../../src/utils/embedding.js', () => ({
  embedText: jest.fn(async () => [1, 0, 0]),
  cosineSimilarity: jest.fn(() => 0),
}));

const { getDb } = await import('../../src/ledger/index.js');
const { checkSemanticCache, getReferencedFilesHashes } = await import('../../src/cache/index.js');

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'semcache-'));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src/app.ts'), 'export const a = 1;\n');
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('getReferencedFilesHashes', () => {
  it('resolves a relative path against the workspace it was given', async () => {
    const hashes = await getReferencedFilesHashes('see src/app.ts for the export', workspace);
    expect(Object.keys(hashes)).toEqual([path.join(workspace, 'src/app.ts')]);
  });

  it('hashes no relative path when no workspace is known', async () => {
    const hashes = await getReferencedFilesHashes('see src/app.ts for the export');
    expect(hashes).toEqual({});
  });
});

describe('semcache retention', () => {
  it('drops rows older than ELISION_RETENTION_DAYS when the cache is opened', async () => {
    const db = getDb();
    db.exec('CREATE TABLE IF NOT EXISTS semcache (id TEXT PRIMARY KEY, embedding_blob BLOB, response TEXT, file_hashes TEXT, ts TEXT)');
    const old = new Date();
    old.setDate(old.getDate() - 181);
    const insert = db.prepare('INSERT INTO semcache (id, embedding_blob, response, file_hashes, ts) VALUES (?, ?, ?, ?, ?)');
    insert.run('old', Buffer.from(new Float64Array([1, 0, 0]).buffer), '"old"', '{}', old.toISOString());
    insert.run('new', Buffer.from(new Float64Array([1, 0, 0]).buffer), '"new"', '{}', new Date().toISOString());

    await checkSemanticCache('anything');

    const ids = (db.prepare('SELECT id FROM semcache').all() as { id: string }[]).map(r => r.id);
    expect(ids).toEqual(['new']);
  });
});
