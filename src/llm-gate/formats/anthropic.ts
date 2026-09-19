import crypto from 'node:crypto';
import { FirstRequestPrompt, JsonObject, LocalReply, ToolResult, typedText } from './contract.js';
import { InternalRequest, InternalMessage } from './internal.js';

/**
 * Parses an incoming Anthropic-formatted messages request and translates it 
 * into the agnostic `InternalRequest` structure.
 * Anthropic uses a top-level `system` field, which seamlessly maps to our internal structure.
 * 
 * @param body The raw JSON body of an Anthropic API request
 * @param modelFallback A default model to use if the request omits it
 */
export function parseAnthropicRequest(body: any, modelFallback: string): InternalRequest {
  const messages: InternalMessage[] = [];
  let system: string | undefined;

  if (body.system) {
    if (typeof body.system === 'string') {
      system = body.system;
    } else if (Array.isArray(body.system)) {
      system = body.system.map((b: any) => b.text || '').join('\n');
    }
  }

  for (const m of (body.messages || [])) {
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map((b: any) => b.text || JSON.stringify(b)).join('\n');
    }
    messages.push({ role: m.role, content });
  }

  return {
    system,
    messages,
    maxTokens: body.max_tokens,
    stream: !!body.stream,
    tools: body.tools, // If Anthropic native tools are sent
    model: body.model || modelFallback
  };
}

export function buildAnthropicRequest(internal: InternalRequest): any {
  // Strip out any internal system messages from the messages array
  const cleanMessages = internal.messages.filter(m => m.role !== 'system');
  
  const req: any = {
    model: internal.model,
    messages: cleanMessages.map(m => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.content })),
    max_tokens: internal.maxTokens || 4096, // REQUIRED for Anthropic
  };
  
  // 1. Breakpoint on system block
  if (internal.system) {
    req.system = [{ type: 'text', text: internal.system, cache_control: { type: 'ephemeral' } }];
  }
  
  // 2. Breakpoint on last tool
  if (internal.tools && internal.tools.length > 0) {
    req.tools = [...internal.tools];
    req.tools[req.tools.length - 1] = {
      ...req.tools[req.tools.length - 1],
      cache_control: { type: 'ephemeral' }
    };
  }
  
  // 3. Breakpoint on historical message (skip current turn)
  if (req.messages.length >= 3) {
    // A standard turn is user -> assistant -> user, so length - 3 skips the current uncompleted turn
    const targetIdx = req.messages.length - 3;
    req.messages[targetIdx].content = [
      { type: 'text', text: req.messages[targetIdx].content as string, cache_control: { type: 'ephemeral' } }
    ];
  }
  
  if (internal.stream) {
    req.stream = true;
  }

  return req;
}

export function formatAnthropicStreamChunk(content: string, isFirst: boolean = false, isLast: boolean = false, usage: any = null): string {
  let chunks = '';

  if (isFirst) {
    chunks += `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'local', content: [] } })}\n\n`;
    chunks += `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`;
  }

  if (content) {
    chunks += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } })}\n\n`;
  }

  if (isLast) {
    chunks += `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`;
    chunks += `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })}\n\n`;
    chunks += `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
  }

  return chunks;
}

// ---------------------------------------------------------------------------------------------------
// Model gate contract (formats/contract.ts). Tool results are `tool_result` blocks in user messages;
// their `content` is a string, or an array whose text parts are the text (images etc. are left alone).
// The call is the `tool_use` block with the same id in an assistant message.
// ---------------------------------------------------------------------------------------------------

/** messages[message].content[block], and the text part when that block's content is an array. */
export interface AnthropicToolResultLocation {
  message: number;
  block: number;
  part?: number;
}

export function listToolResults(body: JsonObject): ToolResult<AnthropicToolResultLocation>[] {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const calls = new Map<string, { name: string; input: unknown }>();
  let lastAssistant = -1;
  messages.forEach((message, i) => {
    if (message?.role !== 'assistant') return;
    lastAssistant = i;
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') calls.set(block.id, { name: String(block.name ?? ''), input: block.input });
    }
  });

  const results: ToolResult<AnthropicToolResultLocation>[] = [];
  messages.forEach((message, i) => {
    if (message?.role !== 'user' || !Array.isArray(message.content)) return;
    message.content.forEach((block: any, j: number) => {
      if (block?.type !== 'tool_result') return;
      const call = calls.get(block.tool_use_id);
      const found = { toolName: call?.name ?? '', callArgs: call?.input, newTurn: i > lastAssistant };
      if (typeof block.content === 'string') {
        results.push({ ...found, location: { message: i, block: j }, text: block.content });
      } else if (Array.isArray(block.content)) {
        block.content.forEach((part: any, k: number) => {
          if (part?.type === 'text' && typeof part.text === 'string') {
            results.push({ ...found, location: { message: i, block: j, part: k }, text: part.text });
          }
        });
      }
    });
  });
  return results;
}

export function replaceToolResultText(params: { body: JsonObject; location: AnthropicToolResultLocation; text: string }): JsonObject {
  const { body, location: { message, block, part }, text } = params;
  const messages = [...body.messages];
  const content = [...messages[message].content];
  const result = content[block];
  content[block] = part === undefined
    ? { ...result, content: text }
    : { ...result, content: result.content.map((p: any, k: number) => (k === part ? { ...p, text } : p)) };
  messages[message] = { ...messages[message], content };
  return { ...body, messages };
}

export function firstRequestPrompt(body: JsonObject): FirstRequestPrompt | null {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.some(message => message?.role === 'assistant')) return null;
  // Structured output (Claude Code's title side request) or a forced tool call cannot be a text reply.
  if (body.output_config?.format || body.output_format) return null;
  if (body.tool_choice?.type === 'any' || body.tool_choice?.type === 'tool') return null;

  const lastUser = [...messages].reverse().find(message => message?.role === 'user');
  const content = lastUser?.content;
  const texts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text)
      : [];
  const text = typedText(texts);
  return text ? { text, toolsListed: Array.isArray(body.tools) && body.tools.length > 0 } : null;
}

export function buildLocalReply(params: { text: string; stream: boolean; model: string; usage: { inputTokens: number; outputTokens: number } }): LocalReply {
  const { text, stream, model, usage } = params;
  const message = {
    id: `msg_slmgate_${crypto.randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
  };
  if (!stream) return { contentType: 'application/json', body: JSON.stringify(message) };

  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return {
    contentType: 'text/event-stream; charset=utf-8',
    body:
      event('message_start', {
        type: 'message_start',
        message: { ...message, content: [], stop_reason: null, usage: { input_tokens: usage.inputTokens, output_tokens: 1 } },
      }) +
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
      event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.outputTokens } }) +
      event('message_stop', { type: 'message_stop' }),
  };
}
