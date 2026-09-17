import { afterEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __resetProviderRegistry } from '../src/pricing/providers.js';
import { writeReport } from './report.js';

const stats = (o: { routingRate: number; inTokens: number }) => ({ accuracy: 1, cost: 0, outTokens: 0, ...o });

// 10 tasks. Arm A sends 10,000 tokens to the cloud; Arm B sends 4,000 and answers 6 prompts locally.
const renderReport = (): string => {
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'report-')), 'leaderboard.md');
  const arms = {
    allSlm: stats({ routingRate: 0, inTokens: 0 }),
    armA: stats({ routingRate: 1, inTokens: 10_000 }),
    armB: stats({ routingRate: 0.4, inTokens: 4_000 }),
    CIs: { allSlm: [1, 1], armA: [1, 1], armB: [1, 1] } as Record<string, [number, number]>,
  };
  writeReport(outPath, arms, true, 10, 0);
  return fs.readFileSync(outPath, 'utf8');
};

describe('leaderboard window impact', () => {
  afterEach(() => {
    for (const id of ['CLAUDE', 'CHATGPT', 'GEMINI']) delete process.env[`${id}_WINDOW_BUDGET`];
    __resetProviderRegistry();
  });

  it('uses the dashboard formula: tokens for Claude, local prompts for ChatGPT', () => {
    process.env.CLAUDE_WINDOW_BUDGET = '1000000'; // 6,000 tokens saved * 300 / 1e6 = 1.8 min
    process.env.CHATGPT_WINDOW_BUDGET = '90';     // 6 local prompts * 180 / 90 = 12 min
    __resetProviderRegistry();
    const report = renderReport();
    // Rendered as real durations: 1.8 min and 12 min, not decimals the reader must convert.
    expect(report).toContain('**Claude** (5-hour window): estimated **~1m 48s** of window time saved');
    expect(report).toContain('**ChatGPT** (3-hour window): estimated **~12m 00s** of window time saved');
    expect(report).toContain('margin of error');
  });

  it('says a provider is not measured instead of inventing a number when its budget is unset', () => {
    __resetProviderRegistry();
    expect(renderReport()).toContain('**Gemini** (5-hour window): not measured. Set `GEMINI_WINDOW_BUDGET`');
  });
});
