import { describe, expect, it } from '@jest/globals';
import * as anthropic from '../../src/llm-gate/formats/anthropic.js';
import * as chatCompletions from '../../src/llm-gate/formats/chat-completions.js';
import * as gemini from '../../src/llm-gate/formats/gemini.js';
import * as responses from '../../src/llm-gate/formats/responses.js';

const TEXT = 'He said "hi"\nline two — ✓ 日本';
const USAGE = { inputTokens: 1200, outputTokens: 9 };

/** Server-sent events as a client reads them: [event name or null, parsed data or the raw string]. */
function sse(body: string): [string | null, any][] {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const name = /^event: (.*)$/m.exec(block)?.[1] ?? null;
    const data = /^data: (.*)$/m.exec(block)![1];
    return [name, data === '[DONE]' ? data : JSON.parse(data)];
  });
}

describe('firstRequestPrompt', () => {
  it('Anthropic: the typed prompt after injected context blocks, only on a first request', () => {
    const body = {
      tools: [{ name: 'Bash' }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>CLAUDE.md contents…</system-reminder>' },
          { type: 'text', text: 'Say hi' },
          { type: 'text', text: '<ide_opened_file>README.md</ide_opened_file>' },
        ],
      }],
    };
    expect(anthropic.firstRequestPrompt(body)).toEqual({ text: 'Say hi', toolsListed: true });
    expect(anthropic.firstRequestPrompt({ ...body, messages: [...body.messages, { role: 'assistant', content: 'Hi' }, { role: 'user', content: 'again' }] })).toBeNull();
    expect(anthropic.firstRequestPrompt({ ...body, output_config: { format: { type: 'json_schema' } } })).toBeNull();
    expect(anthropic.firstRequestPrompt({ ...body, tool_choice: { type: 'any' } })).toBeNull();
    expect(anthropic.firstRequestPrompt({ messages: [{ role: 'user', content: 'hello' }] })).toEqual({ text: 'hello', toolsListed: false });
  });

  it('Chat Completions: a system message first is fine; structured output or forced tools are not', () => {
    const body = { tools: [{ type: 'function', function: { name: 'read' } }], messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Say hi' }] };
    expect(chatCompletions.firstRequestPrompt(body)).toEqual({ text: 'Say hi', toolsListed: true });
    expect(chatCompletions.firstRequestPrompt({ ...body, response_format: { type: 'json_object' } })).toBeNull();
    expect(chatCompletions.firstRequestPrompt({ ...body, tool_choice: 'required' })).toBeNull();
    expect(chatCompletions.firstRequestPrompt({ messages: [...body.messages, { role: 'assistant', content: 'Hi' }, { role: 'user', content: 'x' }] })).toBeNull();
  });

  it('Responses: string input, or the typed item after environment context; not after a model item', () => {
    expect(responses.firstRequestPrompt({ input: 'Say hi' })).toEqual({ text: 'Say hi', toolsListed: false });
    const body = {
      tools: [{ type: 'function', name: 'shell' }],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] },
      ],
    };
    expect(responses.firstRequestPrompt(body)).toEqual({ text: 'Say hi', toolsListed: true });
    expect(responses.firstRequestPrompt({ ...body, previous_response_id: 'resp_1' })).toBeNull();
    expect(responses.firstRequestPrompt({ ...body, text: { format: { type: 'json_schema' } } })).toBeNull();
    expect(responses.firstRequestPrompt({ ...body, input: [{ type: 'reasoning', id: 'rs', encrypted_content: 'x' }, ...body.input] })).toBeNull();
  });

  it('Gemini: the typed part after the environment part; not after a model turn or for JSON output', () => {
    const body = {
      tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
      contents: [{ role: 'user', parts: [{ text: 'This is the Gemini CLI. Environment: …' }, { text: 'Say hi' }] }],
    };
    expect(gemini.firstRequestPrompt(body)).toEqual({ text: 'Say hi', toolsListed: true });
    expect(gemini.firstRequestPrompt({ ...body, generationConfig: { responseMimeType: 'application/json' } })).toBeNull();
    expect(gemini.firstRequestPrompt({ ...body, toolConfig: { functionCallingConfig: { mode: 'ANY' } } })).toBeNull();
    expect(gemini.firstRequestPrompt({ contents: [...body.contents, { role: 'model', parts: [{ text: 'Hi' }] }, { role: 'user', parts: [{ text: 'x' }] }] })).toBeNull();
  });
});

describe('buildLocalReply', () => {
  it('Anthropic: the full event sequence of a final text message, and the JSON message', () => {
    const streamed = anthropic.buildLocalReply({ text: TEXT, stream: true, model: 'qwen', usage: USAGE });
    const events = sse(streamed.body);

    expect(streamed.contentType).toMatch(/^text\/event-stream/);
    expect(events.map(([name]) => name)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(events.every(([name, data]) => data.type === name)).toBe(true);
    expect(events[0][1].message).toMatchObject({ role: 'assistant', model: 'qwen', content: [], usage: { input_tokens: 1200 } });
    expect(events[2][1].delta).toEqual({ type: 'text_delta', text: TEXT });
    expect(events[4][1]).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } });

    const whole = JSON.parse(anthropic.buildLocalReply({ text: TEXT, stream: false, model: 'qwen', usage: USAGE }).body);
    expect(whole).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: TEXT }], stop_reason: 'end_turn' });
  });

  it('Chat Completions: chunks ending in stop and [DONE], and the completion object', () => {
    const events = sse(chatCompletions.buildLocalReply({ text: TEXT, stream: true, model: 'qwen', usage: USAGE }).body);
    const chunks = events.slice(0, -1).map(([, data]) => data);

    expect(events[events.length - 1][1]).toBe('[DONE]');
    expect(chunks.every(chunk => chunk.object === 'chat.completion.chunk' && chunk.id === chunks[0].id)).toBe(true);
    expect(chunks.map(chunk => chunk.choices[0].delta.content ?? '').join('')).toBe(TEXT);
    expect(chunks[chunks.length - 1]).toMatchObject({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 9 } });

    const whole = JSON.parse(chatCompletions.buildLocalReply({ text: TEXT, stream: false, model: 'qwen', usage: USAGE }).body);
    expect(whole).toMatchObject({ object: 'chat.completion', choices: [{ message: { role: 'assistant', content: TEXT }, finish_reason: 'stop' }] });
  });

  it('Responses: the event sequence from created to completed, and the response object', () => {
    const events = sse(responses.buildLocalReply({ text: TEXT, stream: true, model: 'qwen', usage: USAGE }).body);

    expect(events.map(([name]) => name)).toEqual([
      'response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
      'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed',
    ]);
    expect(events.map(([, data]) => data.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events[4][1].delta).toBe(TEXT);
    const completed = events[8][1].response;
    expect(completed).toMatchObject({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: TEXT }] }], usage: { input_tokens: 1200, output_tokens: 9 } });

    const whole = JSON.parse(responses.buildLocalReply({ text: TEXT, stream: false, model: 'qwen', usage: USAGE }).body);
    expect(whole).toMatchObject({ object: 'response', status: 'completed', output: [{ content: [{ text: TEXT }] }] });
  });

  it('Gemini: one server-sent candidate with STOP, or the same JSON', () => {
    const streamed = gemini.buildLocalReply({ text: TEXT, stream: true, model: 'qwen', usage: USAGE });
    const events = sse(streamed.body);

    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({ candidates: [{ content: { role: 'model', parts: [{ text: TEXT }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1200 } });
    // Each reply gets its own responseId; everything else is the same JSON.
    const { responseId: _streamed, ...streamedReply } = events[0][1];
    const { responseId: _whole, ...wholeReply } = JSON.parse(gemini.buildLocalReply({ text: TEXT, stream: false, model: 'qwen', usage: USAGE }).body);
    expect(wholeReply).toEqual(streamedReply);
  });
});
