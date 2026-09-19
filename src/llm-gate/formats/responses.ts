/**
 * @fileoverview OpenAI Responses (Codex), for the model gate contract (formats/contract.ts).
 *
 * Tool results are `function_call_output`, `custom_tool_call_output` or `local_shell_call_output` items
 * in `input`; their `output` is a string or an array whose `input_text` parts are the text (images are
 * left alone). The call is the `function_call` / `custom_tool_call` / `local_shell_call` item with the
 * same `call_id`. Reasoning items (including encrypted reasoning) are never touched.
 */
import { JsonObject, ToolResult } from './contract.js';

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
