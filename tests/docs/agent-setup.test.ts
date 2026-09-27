import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { CONFIG_ENV_KEYS } from '../../src/config.js';
import { ramPresets } from '../../src/hardware.js';
import { getValidPlanKeys } from '../../src/pricing/plans.js';

// The AI setup prompt tells assistants that anything it does not list does not exist, so it must list exactly
// what slm-gate reads and runs: an assistant trusts it over its own guesses.
const page = fs.readFileSync('docs/agent-setup.md', 'utf8');
const prompt = page.split('```text\n')[1].split('\n```')[0];
const section = (params: { from: string; to: string }) => prompt.slice(prompt.indexOf(params.from), prompt.indexOf(params.to));

// Read outside the settings schema: where the settings file lives (src/home-dir.ts), the savings cards'
// window budgets (src/ledger), and the price list override (src/pricing/providers.ts).
const OTHER_SETTINGS = ['SLM_GATE_HOME', 'CLAUDE_WINDOW_BUDGET', 'CHATGPT_WINDOW_BUDGET', 'GEMINI_WINDOW_BUDGET', 'PROVIDER_REGISTRY_PATH'];
const realSettings = [...CONFIG_ENV_KEYS, ...OTHER_SETTINGS];

describe('the AI setup prompt (docs/agent-setup.md)', () => {
  it('lists every setting slm-gate reads, once each, and nothing else', () => {
    const listed = [...section({ from: 'Every setting that exists:', to: 'Valid values:' }).matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(m => m[1]);
    expect(listed.length).toBe(new Set(listed).size);
    expect([...listed].sort()).toEqual([...realSettings].sort());
  });

  it('names no setting that does not exist, anywhere on the page', () => {
    const named = [...page.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map(m => m[0]);
    expect(named.filter(name => !realSettings.includes(name))).toEqual([]);
  });

  it('offers exactly the RAM presets and plans slm-gate accepts', () => {
    const presetLine = prompt.match(/- RAM_PRESET: (.*)/)?.[1] ?? '';
    expect(presetLine.match(/ram-\d+|custom/g)).toEqual(Object.keys(ramPresets));
    const planList = prompt.match(/- Plans: ([^.]*)\./)?.[1] ?? '';
    expect(planList.split(',').map(plan => plan.trim())).toEqual(getValidPlanKeys());
  });

  it('uses only slm-gate commands that exist', () => {
    const help = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'help'], { encoding: 'utf8' });
    const commands = [...help.matchAll(/^ {2}([a-z][a-z:-]*) /gm)].map(m => m[1]).concat('--version');
    const used = [...page.matchAll(/`(?:slm-gate|npx -y @zenithfoundry\/slm-gate@1) ([^\s`]+)/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter(command => !commands.includes(command))).toEqual([]);
  });
});
