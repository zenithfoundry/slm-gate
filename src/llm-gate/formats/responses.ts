/**
 * @fileoverview OpenAI Responses (Codex), for the model gate contract (formats/contract.ts).
 *
 * Tool results are `function_call_output`, `custom_tool_call_output` or `local_shell_call_output` items
 * in `input`; their `output` is a string or an array whose `input_text` parts are the text (images are
 * left alone). The call is the `function_call` / `custom_tool_call` / `local_shell_call` item with the
 * same `call_id`. Reasoning items (including encrypted reasoning) are never touched.
 */
import crypto from 'node:crypto';
import { FirstRequestPrompt, JsonObject, LocalReply, ToolResult, typedText } from './contract.js';

/** input[item], and the text part when its output is an array. */
export interface ResponsesToolResultLocation {
  item: number;
  part?: number;
}

const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** An item the model produced: an assistant message, a reasoning item, or any call it made. */
function isModelItem(item: any): boolean {
  if (item?.role === 'assistant') return true;
  const type = item?.type;
  return typeof type === 'string' && type !== 'message' && type !== 'item_reference' && !type.endsWith('_output');
}

function callOf(item: any): { name: string; args: unknown } | null {
  switch (item?.type) {
    case 'function_call':
      return { name: String(item.name ?? ''), args: parseArguments(item.arguments) };
    case 'custom_tool_call':
      return { name: String(item.name ?? ''), args: parseArguments(item.input) };
    case 'local_shell_call':
      return { name: 'local_shell', args: { command: item.action?.command } };
    default:
      return null;
  }
}

export function listToolResults(body: JsonObject): ToolResult<ResponsesToolResultLocation>[] {
  const items: any[] = Array.isArray(body?.input) ? body.input : [];
  const calls = new Map<string, { name: string; args: unknown }>();
  let lastModelItem = -1;
  items.forEach((item, i) => {
    if (isModelItem(item)) lastModelItem = i;
    const call = callOf(item);
    if (call && typeof item.call_id === 'string') calls.set(item.call_id, call);
  });

  const results: ToolResult<ResponsesToolResultLocation>[] = [];
  items.forEach((item, i) => {
    if (!OUTPUT_TYPES.has(item?.type)) return;
    const call = calls.get(item.call_id);
    const found = { toolName: call?.name ?? '', callArgs: call?.args, newTurn: i > lastModelItem };
    if (typeof item.output === 'string') {
      results.push({ ...found, location: { item: i }, text: item.output });
    } else if (Array.isArray(item.output)) {
      item.output.forEach((part: any, k: number) => {
        if (part?.type === 'input_text' && typeof part.text === 'string') results.push({ ...found, location: { item: i, part: k }, text: part.text });
      });
    }
  });
  return results;
}

export function replaceToolResultText(params: { body: JsonObject; location: ResponsesToolResultLocation; text: string }): JsonObject {
  const { body, location: { item, part }, text } = params;
  const input = [...body.input];
  const target = input[item];
  input[item] = part === undefined
    ? { ...target, output: text }
    : { ...target, output: target.output.map((p: any, k: number) => (k === part ? { ...p, text } : p)) };
  return { ...body, input };
}

export function firstRequestPrompt(body: JsonObject): FirstRequestPrompt | null {
  if (body.previous_response_id) return null;
  if (['json_schema', 'json_object'].includes(body.text?.format?.type)) return null;
  if (body.tool_choice === 'required' || (body.tool_choice && typeof body.tool_choice === 'object')) return null;
  const toolsListed = Array.isArray(body.tools) && body.tools.length > 0;
  if (typeof body.input === 'string') {
    const text = typedText([body.input]);
    return text ? { text, toolsListed } : null;
  }

  const items: any[] = Array.isArray(body.input) ? body.input : [];
  if (items.some(isModelItem)) return null;
  const lastUser = [...items].reverse().find(item => item?.role === 'user');
  const content = lastUser?.content;
  const texts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.filter((part: any) => part?.type === 'input_text' && typeof part.text === 'string').map((part: any) => part.text)
      : [];
  const text = typedText(texts);
  return text ? { text, toolsListed } : null;
}

export function buildLocalReply(params: { text: string; stream: boolean; model: string; usage: { inputTokens: number; outputTokens: number } }): LocalReply {
  const { text, stream, model, usage } = params;
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const itemId = `msg_slmgate_${suffix}`;
  const part = { type: 'output_text', text, annotations: [] };
  const item = { type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [part] };
  const response = {
    id: `resp_slmgate_${suffix}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [item],
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: usage.inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
  if (!stream) return { contentType: 'application/json', body: JSON.stringify(response) };

  const inProgress = { ...response, status: 'in_progress', output: [], usage: null };
  const at = { item_id: itemId, output_index: 0, content_index: 0 };
  const events: [string, object][] = [
    ['response.created', { response: inProgress }],
    ['response.in_progress', { response: inProgress }],
    ['response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
    ['response.content_part.added', { ...at, part: { ...part, text: '' } }],
    ['response.output_text.delta', { ...at, delta: text }],
    ['response.output_text.done', { ...at, text }],
    ['response.content_part.done', { ...at, part }],
    ['response.output_item.done', { output_index: 0, item }],
    ['response.completed', { response }],
  ];
  return {
    contentType: 'text/event-stream; charset=utf-8',
    body: events.map(([type, data], sequence) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...data })}\n\n`).join(''),
  };
}
