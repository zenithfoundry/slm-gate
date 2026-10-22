import { describe, it, expect } from '@jest/globals';
import { parseOpenAIRequest, buildOpenAIRequest } from '../../src/llm-gate/formats/openai.js';
import { parseAnthropicRequest, buildAnthropicRequest, toolStats } from '../../src/llm-gate/formats/anthropic.js';

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

describe('OpenAI Format', () => {
  it('parses inbound and serializes outbound with stream usage flag', () => {
    const raw = {
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: 'You are an AI.' },
        { role: 'user', content: 'Hello!' }
      ],
      stream: true,
      max_tokens: 100
    };

    const internal = parseOpenAIRequest(raw, 'fallback');
    expect(internal.system).toBe('You are an AI.');
    expect(internal.messages.length).toBe(2);
    expect(internal.stream).toBe(true);

    const outbound = buildOpenAIRequest(internal);
    expect(outbound.model).toBe('gpt-5.6-sol');
    expect(outbound.messages).toEqual([
      { role: 'system', content: 'You are an AI.' },
      { role: 'user', content: 'Hello!' }
    ]);
    expect(outbound.stream_options).toEqual({ include_usage: true });
    expect(outbound.max_tokens).toBe(100);
  });
});

describe('Anthropic Format', () => {
  it('parses inbound system hoist and serializes outbound with max_tokens enforcement', () => {
    const raw = {
      model: 'claude-3',
      system: 'Top level system',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' }
      ]
    };

    const internal = parseAnthropicRequest(raw, 'fallback');
    expect(internal.system).toBe('Top level system');
    expect(internal.messages.length).toBe(2);

    // If an internal request somehow had a system message in the array, it gets stripped out and placed at top
    internal.messages.unshift({ role: 'system', content: 'Should be stripped' });
    
    const outbound = buildAnthropicRequest(internal);
    expect(outbound.system).toEqual([{ type: 'text', text: 'Top level system', cache_control: { type: 'ephemeral' } }]);
    expect(outbound.messages.length).toBe(2);
    expect(outbound.max_tokens).toBe(4096); // default enforced
    expect(outbound.messages[0].role).toBe('user');
  });
});
