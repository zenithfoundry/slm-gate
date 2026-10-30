/**
 * The Anthropic Messages shape of the model gate contract: finds tool results and the calls that produced
 * them in a request body and rewrites their text in place.
 */
import { CHARS_PER_TOKEN } from '../../utils/elision.js';
import { HistoryEntry, JsonObject, ToolResult, ToolStats, typedText } from './contract.js';

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

/**
 * Counts the request's tool definitions and how many carry `defer_loading: true` (Anthropic's server-side
 * tool search keeps those out of the context). A read-only measure for the ledger: behind a non-Anthropic
 * address Claude Code stops marking tools deferred unless ENABLE_TOOL_SEARCH is set, and the only way to see
 * whether that worked is to count.
 */
export function toolStats(body: JsonObject): ToolStats | null {
  const tools = Array.isArray(body?.tools) ? body.tools : null;
  if (!tools) return null;
  let deferred = 0;
  let chars = 0;
  for (const tool of tools) {
    if (tool?.defer_loading === true) { deferred++; continue; }
    chars += JSON.stringify(tool ?? null).length;
  }
  return { count: tools.length, deferred, tokEst: Math.ceil(chars / CHARS_PER_TOKEN) };
}

/** How much of a tool result the memory fold sees: enough to know what it was about, never the whole thing. */
const TOOL_RESULT_PREVIEW = 200;

/**
 * The conversation as memory entries: typed user text, assistant text, and for each tool result the tool's
 * name with a short preview. Injected blocks (system reminders and the like) are left out as `typedText` does.
 */
export function historyEntries(body: JsonObject): HistoryEntry[] {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const calls = new Map<string, string>();
  const out: HistoryEntry[] = [];
  for (const message of messages) {
    const content = message?.content;
    if (message?.role === 'assistant') {
      const texts: string[] = [];
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') calls.set(block.id, String(block.name ?? ''));
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
      if (typeof content === 'string') texts.push(content);
      if (texts.length) out.push({ role: 'assistant', text: texts.join('\n') });
      continue;
    }
    if (message?.role !== 'user') continue;
    if (typeof content === 'string') {
      const text = typedText([content]);
      if (text) out.push({ role: 'user', text });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const texts = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text);
    const typed = texts.length ? typedText(texts) : null;
    if (typed) out.push({ role: 'user', text: typed });
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const name = calls.get(block.tool_use_id) ?? 'tool';
      const raw = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content) ? block.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') : '';
      out.push({ role: 'tool', text: `${name}: ${raw.slice(0, TOOL_RESULT_PREVIEW)}` });
    }
  }
  return out;
}

/**
 * The workspace a Claude Code request names: its system prompt states the working directory as plain text.
 * The first absolute path on a line that mentions a working directory; null when there is no such line. Pure.
 */
export function workspaceOf(body: JsonObject): string | null {
  const system = typeof body?.system === 'string'
    ? body.system
    : Array.isArray(body?.system) ? body.system.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';
  for (const line of system.split('\n')) {
    if (!/working directory/i.test(line)) continue;
    // An absolute path starts at the line start or after whitespace/punctuation, never mid-word (`repos/project`).
    const m = /(?:^|[\s:=`'"(])(\/[^\s`'"]+)/.exec(line);
    if (m) return m[1].replace(/[.,;:]+$/, '');
  }
  return null;
}

