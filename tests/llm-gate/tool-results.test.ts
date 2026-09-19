import { describe, expect, it } from '@jest/globals';
import * as anthropic from '../../src/llm-gate/formats/anthropic.js';
import * as chatCompletions from '../../src/llm-gate/formats/chat-completions.js';
import { JsonObject, WireFormatModule } from '../../src/llm-gate/formats/contract.js';
import * as gemini from '../../src/llm-gate/formats/gemini.js';
import * as responses from '../../src/llm-gate/formats/responses.js';

/**
 * Fixtures follow the shapes captured from Claude Code and Gemini CLI (2026-09-18) and the documented
 * Chat Completions / Responses shapes. In each, one tool result is from an earlier turn ('OLD …') and
 * one is new ('NEW …'), and the parts the gate must never touch are present.
 */
const FIXTURES: Record<string, { format: WireFormatModule; body: JsonObject }> = {
  anthropic: {
    format: anthropic,
    body: {
      model: 'claude-sonnet-5',
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
        { role: 'system', content: 'reminder' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'sig-1' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'OLD BASH OUTPUT', is_error: false },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'OLD FILE' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
          ],
        },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Grep', input: { pattern: 'x' }, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        { role: 'user', content: [{ tool_use_id: 'toolu_3', type: 'tool_result', content: 'NEW GREP OUTPUT', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      ],
    },
  },
  chatCompletions: {
    format: chatCompletions,
    body: {
      model: 'gpt-5.6-sol',
      tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }],
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":["bash","-lc","ls -la"]}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'OLD LS OUTPUT' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'grep', arguments: 'not json' } }] },
        { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: 'NEW GREP OUTPUT' }] },
      ],
    },
  },
  responses: {
    format: responses,
    body: {
      model: 'gpt-5.6-codex',
      instructions: 'sys',
      store: false,
      include: ['reasoning.encrypted_content'],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC-1' },
        { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["bash","-lc","rg foo"]}' },
        { type: 'function_call_output', call_id: 'c1', output: 'OLD RG OUTPUT' },
        { type: 'function_call', call_id: 'c2', name: 'shell', arguments: '{"command":["bash","-lc","ls"]}' },
        { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'NEW LS OUTPUT' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] },
      ],
    },
  },
  gemini: {
    format: gemini,
    body: {
      systemInstruction: { parts: [{ text: 'sys' }] },
      tools: [{ functionDeclarations: [{ name: 'grep_search' }, { name: 'list_directory' }] }],
      contents: [
        { role: 'user', parts: [{ text: 'go' }] },
        { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'list_directory', args: { dir_path: 'src' } }, thoughtSignature: 'SIG-1' }] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'list_directory', response: { output: 'OLD LIST OUTPUT' } } }] },
        { role: 'model', parts: [{ functionCall: { name: 'grep_search', args: { pattern: 'x' } }, thoughtSignature: 'SIG-2' }] },
        { role: 'user', parts: [{ functionResponse: { name: 'grep_search', response: { output: 'NEW GREP OUTPUT' } } }] },
      ],
    },
  },
};

describe('listToolResults', () => {
  it('finds Anthropic tool_result strings and text parts with their call and turn', () => {
    const found = anthropic.listToolResults(FIXTURES.anthropic.body);
    expect(found).toEqual([
      { location: { message: 3, block: 0 }, text: 'OLD BASH OUTPUT', toolName: 'Bash', callArgs: { command: 'npm test' }, newTurn: false },
      { location: { message: 3, block: 1, part: 0 }, text: 'OLD FILE', toolName: 'Read', callArgs: { file_path: 'a.ts' }, newTurn: false },
      { location: { message: 5, block: 0 }, text: 'NEW GREP OUTPUT', toolName: 'Grep', callArgs: { pattern: 'x' }, newTurn: true },
    ]);
  });

  it('finds Chat Completions tool messages and parses call arguments when they are JSON', () => {
    const found = chatCompletions.listToolResults(FIXTURES.chatCompletions.body);
    expect(found).toEqual([
      { location: { message: 3 }, text: 'OLD LS OUTPUT', toolName: 'shell', callArgs: { command: ['bash', '-lc', 'ls -la'] }, newTurn: false },
      { location: { message: 5, part: 0 }, text: 'NEW GREP OUTPUT', toolName: 'grep', callArgs: 'not json', newTurn: true },
    ]);
  });

  it('finds Responses call outputs, treating calls and reasoning as model turns', () => {
    const found = responses.listToolResults(FIXTURES.responses.body);
    expect(found).toEqual([
      { location: { item: 3 }, text: 'OLD RG OUTPUT', toolName: 'shell', callArgs: { command: ['bash', '-lc', 'rg foo'] }, newTurn: false },
      { location: { item: 5, part: 0 }, text: 'NEW LS OUTPUT', toolName: 'shell', callArgs: { command: ['bash', '-lc', 'ls'] }, newTurn: true },
    ]);
  });

  it('finds Gemini function responses, matching calls by id or else by the latest earlier name', () => {
    const found = gemini.listToolResults(FIXTURES.gemini.body);
    expect(found).toEqual([
      { location: { content: 2, part: 0 }, text: 'OLD LIST OUTPUT', toolName: 'list_directory', callArgs: { dir_path: 'src' }, newTurn: false },
      { location: { content: 4, part: 0 }, text: 'NEW GREP OUTPUT', toolName: 'grep_search', callArgs: { pattern: 'x' }, newTurn: true },
    ]);
  });

  it('returns nothing for bodies without a history', () => {
    for (const { format } of Object.values(FIXTURES)) expect(format.listToolResults({ model: 'x' })).toEqual([]);
  });
});

describe('replaceToolResultText', () => {
  for (const [name, { format, body }] of Object.entries(FIXTURES)) {
    it(`${name}: changes only the one tool-result string, byte for byte, and leaves the input untouched`, () => {
      const before = JSON.stringify(body);
      const target = format.listToolResults(body).find(result => result.newTurn)!;

      const replaced = format.replaceToolResultText({ body, location: target.location, text: 'DISTILLED' });

      // Same JSON with exactly that one string swapped: key order, every other block, thinking and
      // thought signatures, cache_control, images, ids, and all counts are identical.
      expect(JSON.stringify(replaced)).toBe(before.replace(JSON.stringify(target.text), '"DISTILLED"'));
      expect(JSON.stringify(body)).toBe(before);
    });
  }
});
