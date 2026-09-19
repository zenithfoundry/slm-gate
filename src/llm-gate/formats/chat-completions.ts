/**
 * @fileoverview OpenAI Chat Completions, for the model gate contract (formats/contract.ts).
 *
 * Tool results are `role: 'tool'` messages (legacy: `role: 'function'` with a `name`). Their `content`
 * is a string or an array of parts whose `text` parts are the text. The call is the entry with the
 * same id in a preceding assistant message's `tool_calls`; its `arguments` is a JSON string.
 */
import crypto from 'node:crypto';
import { FirstRequestPrompt, JsonObject, LocalReply, ToolResult, typedText } from './contract.js';

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

export function firstRequestPrompt(body: JsonObject): FirstRequestPrompt | null {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.some(message => message?.role === 'assistant')) return null;
  if (['json_schema', 'json_object'].includes(body.response_format?.type)) return null;
  if (body.tool_choice === 'required' || (body.tool_choice && typeof body.tool_choice === 'object')) return null;

  const lastUser = [...messages].reverse().find(message => message?.role === 'user');
  const content = lastUser?.content;
  const texts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text)
      : [];
  const text = typedText(texts);
  const toolsListed = (Array.isArray(body.tools) && body.tools.length > 0) || (Array.isArray(body.functions) && body.functions.length > 0);
  return text ? { text, toolsListed } : null;
}

export function buildLocalReply(params: { text: string; stream: boolean; model: string; usage: { inputTokens: number; outputTokens: number } }): LocalReply {
  const { text, stream, model, usage } = params;
  const id = `chatcmpl-slmgate-${crypto.randomUUID().replace(/-/g, '')}`;
  const created = Math.floor(Date.now() / 1000);
  const tokens = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens };
  if (!stream) {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, logprobs: null, finish_reason: 'stop' }],
        usage: tokens,
      }),
    };
  }
  const chunk = (delta: object, finishReason: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }], ...extra })}\n\n`;
  return {
    contentType: 'text/event-stream; charset=utf-8',
    // Usage rides on the final chunk, so clients that asked for it get it and the rest ignore it.
    body: chunk({ role: 'assistant', content: '' }, null) + chunk({ content: text }, null) + chunk({}, 'stop', { usage: tokens }) + 'data: [DONE]\n\n',
  };
}
