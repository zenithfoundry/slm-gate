import { describe, it, expect } from '@jest/globals';
import { buildGateInstructions, rewriteToolReferences } from './tool-names.js';

const tools = ['get_skill', 'get_skills', 'list_skills'];

describe('rewriteToolReferences', () => {
  it('points a toolbox-prefixed tool reference at slm-gate', () => {
    expect(rewriteToolReferences('Call `mcp__tech-lead-stack__get_skills` first.', tools))
      .toBe('Call `mcp__slm-gate__get_skills` first.');
  });

  it('handles the single-underscore prefix form', () => {
    expect(rewriteToolReferences('use mcp_tech-lead-stack_get_skill', tools)).toBe('use mcp__slm-gate__get_skill');
  });

  it('works for any toolbox name, not just tech-lead-stack', () => {
    expect(rewriteToolReferences('mcp__acme-tools__list_skills', tools)).toBe('mcp__slm-gate__list_skills');
  });

  it('does not match a shorter tool name inside a longer one', () => {
    expect(rewriteToolReferences('mcp__x__get_skills', ['get_skill'])).toBe('mcp__x__get_skills');
  });

  it('leaves tools the toolbox does not serve untouched', () => {
    expect(rewriteToolReferences('mcp__github__create_issue', tools)).toBe('mcp__github__create_issue');
    expect(rewriteToolReferences('mcp__foo__bar_get_skill', tools)).toBe('mcp__foo__bar_get_skill');
  });

  it('is unchanged when run twice', () => {
    const once = rewriteToolReferences('mcp__tech-lead-stack__get_skill', tools);
    expect(rewriteToolReferences(once, tools)).toBe(once);
  });

  it('returns the text as-is when no toolbox tools are known', () => {
    expect(rewriteToolReferences('mcp__tech-lead-stack__get_skill', [])).toBe('mcp__tech-lead-stack__get_skill');
  });
});

describe('buildGateInstructions', () => {
  it('lists the toolbox tools and says to call them on slm-gate', () => {
    const text = buildGateInstructions({ toolNames: tools }) ?? '';
    expect(text).toContain('get_skill, get_skills, list_skills');
    expect(text).toContain('mcp__slm-gate__<tool>');
  });

  it("passes the toolbox's own instructions through", () => {
    expect(buildGateInstructions({ toolNames: tools, downstreamInstructions: 'Always call list_skills first.' }))
      .toContain('Always call list_skills first.');
  });

  it('returns undefined when there is nothing to say', () => {
    expect(buildGateInstructions({ toolNames: [] })).toBeUndefined();
  });
});
