/**
 * @fileoverview OpenAI Chat Completions, for the model gate contract (formats/contract.ts).
 *
 * Tool results are `role: 'tool'` messages (legacy: `role: 'function'` with a `name`). Their `content`
 * is a string or an array of parts whose `text` parts are the text. The call is the entry with the
 * same id in a preceding assistant message's `tool_calls`; its `arguments` is a JSON string.
 */
import { JsonObject, ToolResult } from './contract.js';

/** messages[message], and the text part when its content is an array. */
export interface ChatToolResultLocation {
  message: number;
  part?: number;
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function listToolResults(body: JsonObject): ToolResult<ChatToolResultLocation>[] {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const calls = new Map<string, { name: string; args: unknown }>();
  let lastAssistant = -1;
  messages.forEach((message, i) => {
    if (message?.role !== 'assistant') return;
    lastAssistant = i;
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.id === 'string') calls.set(call.id, { name: String(call.function?.name ?? ''), args: parseArguments(call.function?.arguments) });
    }
  });

  const results: ToolResult<ChatToolResultLocation>[] = [];
  messages.forEach((message, i) => {
    if (message?.role !== 'tool' && message?.role !== 'function') return;
    const call = calls.get(message.tool_call_id);
    const found = { toolName: call?.name ?? String(message.name ?? ''), callArgs: call?.args, newTurn: i > lastAssistant };
    if (typeof message.content === 'string') {
      results.push({ ...found, location: { message: i }, text: message.content });
    } else if (Array.isArray(message.content)) {
      message.content.forEach((part: any, k: number) => {
        if (part?.type === 'text' && typeof part.text === 'string') results.push({ ...found, location: { message: i, part: k }, text: part.text });
      });
    }
  });
  return results;
}

export function replaceToolResultText(params: { body: JsonObject; location: ChatToolResultLocation; text: string }): JsonObject {
  const { body, location: { message, part }, text } = params;
  const messages = [...body.messages];
  const target = messages[message];
  messages[message] = part === undefined
    ? { ...target, content: text }
    : { ...target, content: target.content.map((p: any, k: number) => (k === part ? { ...p, text } : p)) };
  return { ...body, messages };
}
