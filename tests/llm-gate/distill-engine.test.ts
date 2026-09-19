import { describe, expect, it, jest } from '@jest/globals';

// Only the built-in preserve patterns, so the result does not depend on a developer's pattern file.
process.env.DISTILL_PRESERVE_PATH = '';

// The local model is the only thing faked: distillToolResult, its rules and the preserve list are real.
const compressNarrativeRun = jest.fn(async (_params: { text: string }) => 'short summary');
jest.unstable_mockModule('../../src/models/reasoning.js', () => ({ compressNarrativeRun }));

const { distilRequest } = await import('../../src/llm-gate/distill.js');
const anthropic = await import('../../src/llm-gate/formats/anthropic.js');
const { getDb } = await import('../../src/ledger/index.js');

describe('the default distillation engine', () => {
  it('runs distillToolResult with the rule and real tool name, and keeps preserved lines away from the local model', async () => {
    // Plain prose (no `path:line` prefixes), over DISTILL_MAX_TOKENS after the top-50-lines rule, so the
    // summarise phase runs; one WARNING line must survive.
    const lines = Array.from({ length: 40 }, (_, i) =>
      `Paragraph ${i} describes the ordinary background of the build in plain words that can be shortened safely without losing anything that matters for the task, and then it goes on at some length about the same unremarkable details so that the line is long.`);
    lines.splice(20, 0, 'WARNING: never delete the migrations folder');
    const output = lines.join('\n');
    const body = {
      model: 'claude-sonnet-5',
      tools: [{ name: 'Grep' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: `engine test ${Date.now()}` }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_e', name: 'Grep', input: { pattern: 'build' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e', content: output }] },
      ],
    };

    const { body: sent } = await distilRequest({ format: anthropic, body });
    const text: string = sent!.messages[2].content[0].content;

    expect(text).toContain('WARNING: never delete the migrations folder');
    expect(text).toContain('short summary');
    expect(text.length).toBeLessThan(output.length / 4);
    expect(compressNarrativeRun).toHaveBeenCalled();
    for (const [call] of compressNarrativeRun.mock.calls) expect(call.text).not.toContain('WARNING');
    // The engine was given `<rule>:<real name>`: its rules match the rule, policies can match the name.
    const row = getDb().prepare('SELECT tool_name FROM elision_cache WHERE tool_name = ?').get('grep_search:Grep');
    expect(row).toEqual({ tool_name: 'grep_search:Grep' });
  });
});
