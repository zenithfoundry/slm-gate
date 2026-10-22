import { describe, it, expect } from '@jest/globals';
import { toolStats } from '../../src/llm-gate/formats/anthropic.js';

describe('Anthropic tool definition counts (toolStats)', () => {
  const tool = (name: string, deferred?: boolean) => ({
    name, description: 'x'.repeat(40), input_schema: { type: 'object', properties: {} },
    ...(deferred === undefined ? {} : { defer_loading: deferred }),
  });

  it('counts listed and deferred tools and sizes only the ones that enter the context', () => {
    const body = { tools: [tool('Bash'), tool('Read', false), tool('mcp__a__b', true), tool('mcp__a__c', true)] };
    const stats = toolStats(body)!;
    expect(stats.count).toBe(4);
    expect(stats.deferred).toBe(2);
    const inContext = Math.ceil((JSON.stringify(body.tools[0]).length + JSON.stringify(body.tools[1]).length) / 4);
    expect(stats.tokEst).toBe(inContext);
  });

  it('returns null when the request lists no tools and zeros for an empty list', () => {
    expect(toolStats({ messages: [] })).toBeNull();
    expect(toolStats({ tools: [] })).toEqual({ count: 0, deferred: 0, tokEst: 0 });
  });
});

describe('workspaceOf (the workspace a request names, for conversation memory)', () => {
  it('reads the working directory from a Claude Code system prompt, as a string or as text blocks', async () => {
    const { workspaceOf } = await import('../../src/llm-gate/formats/anthropic.js');
    const line = 'Primary working directory: /Users/me/repos/project\nIs a git repository: true';
    expect(workspaceOf({ system: line })).toBe('/Users/me/repos/project');
    expect(workspaceOf({ system: [{ type: 'text', text: 'rules' }, { type: 'text', text: line }] })).toBe('/Users/me/repos/project');
  });

  it('returns null for an Anthropic request with no such line or a relative path', async () => {
    const { workspaceOf } = await import('../../src/llm-gate/formats/anthropic.js');
    expect(workspaceOf({ system: 'You are helpful.' })).toBeNull();
    expect(workspaceOf({ system: 'working directory: repos/project' })).toBeNull();
    expect(workspaceOf({ messages: [] })).toBeNull();
  });

  it('reads the working directory from a Codex environment block', async () => {
    const { workspaceOf } = await import('../../src/llm-gate/formats/responses.js');
    const body = { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/Users/me/repos/project</cwd>\n</environment_context>' }] }] };
    expect(workspaceOf(body)).toBe('/Users/me/repos/project');
    expect(workspaceOf({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] })).toBeNull();
    // Only the first user entry is read: a block in a later entry is not a workspace declaration.
    expect(workspaceOf({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }, body.input[0]] })).toBeNull();
  });

  it('is not implemented for formats with no verified source of a workspace', async () => {
    const gemini = await import('../../src/llm-gate/formats/gemini.js');
    const chat = await import('../../src/llm-gate/formats/chat-completions.js');
    expect((gemini as any).workspaceOf).toBeUndefined();
    expect((chat as any).workspaceOf).toBeUndefined();
  });
});
