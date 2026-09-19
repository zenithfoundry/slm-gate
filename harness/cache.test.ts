import { afterEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import { CONFIG } from '../src/config.js';
import { benchRequest, getCachePath, readCache, writeCache } from './run';

describe('harness requests', () => {
  it('sends a tool list only for --tools-listed runs', () => {
    expect(benchRequest('hi', true).tools?.length).toBeGreaterThan(0);
    expect(benchRequest('hi', false).tools).toBeUndefined();
    expect(benchRequest('hi', false).messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('harness cache logic', () => {
  const taskId = 'test_cache_id';
  const route = 'auto';
  const cachePath = getCachePath(taskId, route);

  afterEach(() => {
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  });

  it('treats entry as a miss and re-fetches when config model changes', () => {
    // Write a cached entry tagged with model "A" (different from current config)
    writeCache(taskId, route, {
      promptVersion: CONFIG.PROMPT_VERSION,
      slmModel: 'some_old_model_A',
      apiModel: CONFIG.CLOUD_MODEL || 'unknown',
      taskId,
      route,
      answer: 'Cached answer',
      inTokens: 10,
      outTokens: 0,
      cost: 0,
      ts: new Date().toISOString()
    });

    // Mock console.log to assert it prints the message
    const originalLog = console.log;
    let logOutput = '';
    console.log = (msg: string) => {
      logOutput += msg + '\n';
    };

    // Load it while config says model "B" (current config SLM_BRAIN_MODEL)
    const result = readCache(taskId, route);

    console.log = originalLog;

    // Assert it's treated as a miss
    expect(result).toBeNull();
    // Assert it prints the re-fetching message
    expect(logOutput).toContain('cache stale (model changed): re-fetching');
  });

  it('treats entry as a hit when everything matches', () => {
    // Write a cached entry that perfectly matches
    writeCache(taskId, route, {
      promptVersion: CONFIG.PROMPT_VERSION,
      slmModel: CONFIG.SLM_GATE_TESTING_MODEL,
      apiModel: CONFIG.CLOUD_MODEL || 'unknown',
      taskId,
      route,
      answer: 'Cached answer',
      inTokens: 10,
      outTokens: 0,
      cost: 0,
      ts: new Date().toISOString()
    });

    const result = readCache(taskId, route);

    // Assert it's treated as a hit
    expect(result).not.toBeNull();
    expect(result?.answer).toBe('Cached answer');
  });
});
