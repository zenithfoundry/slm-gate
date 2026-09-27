import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
const settingsNamedIn = (text: string) => [...text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map(m => m[0]);

// The commands `slm-gate help` lists, and --version.
const commands = [...execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'help'], { encoding: 'utf8' })
  .matchAll(/^ {2}([a-z][a-z:-]*) /gm)].map(m => m[1]).concat('--version');

/** The slm-gate commands in a page's shell blocks and inline code, including those after ; or &&. */
function slmGateCommandsIn(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map(m => m[1]);
  const inline = [...markdown.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
  return [...blocks, ...inline]
    .flatMap(code => code.split(/\n|;|&&/))
    .map(part => part.trim().match(/^slm-gate (\S+)/)?.[1])
    .filter((command): command is string => command !== undefined);
}

/** GitHub's anchors for a markdown file's headings (outside code blocks), and its explicit <a id> anchors. */
function anchorsOf(file: string): Set<string> {
  const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  const headings = [...text.matchAll(/^#{1,6} (.+)$/gm)]
    .map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-'));
  return new Set([...headings, ...[...text.matchAll(/<a id="([^"]+)"/g)].map(m => m[1])]);
}

/** Every link in a page to a file of this repo: relative links, and full GitHub links to its main branch. */
function repoLinksIn(file: string): { target: string; anchor?: string }[] {
  const text = fs.readFileSync(file, 'utf8');
  const relative = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1])
    .filter(href => !/^[a-z]+:/.test(href))
    .map(href => {
      const [target, anchor] = href.split('#');
      return { target: target ? path.join(path.dirname(file), target) : file, anchor };
    });
  const github = [...text.matchAll(/https:\/\/github\.com\/zenithfoundry\/slm-gate\/(?:blob|tree)\/main\/([^\s)`'"<>#]+)(?:#([\w-]+))?/g)]
    .map(m => ({ target: m[1].replace(/[.,;:]+$/, ''), anchor: m[2] }));
  return [...relative, ...github];
}

describe('the AI setup prompt (docs/agent-setup.md)', () => {
  it('lists every setting slm-gate reads, once each, and nothing else', () => {
    const listed = [...section({ from: 'Every setting that exists:', to: 'Valid values:' }).matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(m => m[1]);
    expect(listed.length).toBe(new Set(listed).size);
    expect([...listed].sort()).toEqual([...realSettings].sort());
  });

  it('names no setting that does not exist, anywhere on the page', () => {
    expect(settingsNamedIn(page).filter(name => !realSettings.includes(name))).toEqual([]);
  });

  it('offers exactly the RAM presets and plans slm-gate accepts', () => {
    const presetLine = prompt.match(/- RAM_PRESET: (.*)/)?.[1] ?? '';
    expect(presetLine.match(/ram-\d+|custom/g)).toEqual(Object.keys(ramPresets));
    const planList = prompt.match(/- Plans: ([^.]*)\./)?.[1] ?? '';
    expect(planList.split(',').map(plan => plan.trim())).toEqual(getValidPlanKeys());
  });

  it('uses only slm-gate commands that exist', () => {
    const used = [...page.matchAll(/`(?:slm-gate|npx -y @zenithfoundry\/slm-gate@1) ([^\s`]+)/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter(command => !commands.includes(command))).toEqual([]);
  });
});

describe('the switching page (docs/switch-to-npm.md)', () => {
  const switchPage = fs.readFileSync('docs/switch-to-npm.md', 'utf8');

  it('names no setting that does not exist', () => {
    expect(settingsNamedIn(switchPage).filter(name => !realSettings.includes(name))).toEqual([]);
  });

  it('uses only slm-gate commands that exist', () => {
    const used = slmGateCommandsIn(switchPage);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter(command => !commands.includes(command))).toEqual([]);
  });
});

describe('links on the setup pages', () => {
  it.each(['docs/agent-setup.md', 'docs/switch-to-npm.md', 'docs/agent-setup-validation.md', 'docs/install-from-npm.md'])(
    'every link in %s to this repo points at a file and heading that exist', file => {
      const links = repoLinksIn(file);
      expect(links.length).toBeGreaterThan(0);
      const broken = links.filter(({ target, anchor }) =>
        !fs.existsSync(target) || (anchor !== undefined && target.endsWith('.md') && !anchorsOf(target).has(anchor)));
      expect(broken).toEqual([]);
    });
});
