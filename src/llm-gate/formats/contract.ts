/**
 * @fileoverview The one contract every wire-format module implements for the model gate.
 *
 * Four real formats (Anthropic Messages, Chat Completions, Responses, Gemini) justify this small shared
 * shape; everything else stays local to each format module. Request bodies are plain parsed JSON.
 */
import crypto from 'node:crypto';

export type JsonObject = Record<string, any>;

/** One tool result found in a request body. */
export interface ToolResult<L> {
  /** Where the text sits, in the format's own terms; only replaceToolResultText interprets it. */
  location: L;
  /** The tool result text exactly as the client sent it. */
  text: string;
  /** The function name of the call that produced it ('' when the call cannot be found). */
  toolName: string;
  /** That call's arguments as the client sent them (object, or the raw string when not JSON). */
  callArgs: unknown;
  /** True when the result comes after the model's last turn: the provider has never seen it. */
  newTurn: boolean;
}

export interface WireFormatModule<L = any> {
  listToolResults(body: JsonObject): ToolResult<L>[];
  /** Returns a new body with only that one text replaced; the input is never modified. */
  replaceToolResultText(params: { body: JsonObject; location: L; text: string }): JsonObject;
  /** How many tool definitions the request carries and how many stay out of the context; null when the format has no such notion. */
  toolStats?(body: JsonObject): ToolStats | null;
  /** The whole conversation as memory entries, in order (see HistoryEntry); formats without it fold nothing. */
  historyEntries?(body: JsonObject): HistoryEntry[];
  /** The workspace the request names (an absolute path), or null when it does not say. */
  workspaceOf?(body: JsonObject): string | null;
}

/** One entry of a conversation as the memory fold sees it: who said it and the text, tool results shortened. */
export interface HistoryEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

/**
 * The conversation key: sha256 of the first user entry. Coding tools resend the whole history every turn, so
 * the first entry is stable for the life of a conversation. It is a heuristic identity — two conversations
 * that open with the same message share it — which the memory fold tells apart with the second entry.
 */
export function conversationKey(body: JsonObject): string {
  const history: any[] = body.messages ?? body.contents ?? (Array.isArray(body.input) ? body.input : []);
  const first = history.find(entry => entry?.role === 'user') ?? history[0] ?? null;
  return crypto.createHash('sha256').update(JSON.stringify(first)).digest('hex');
}

/** sha256 of the second user entry, or null while the conversation has only one. */
export function conversationDiscriminator(body: JsonObject): string | null {
  const history: any[] = body.messages ?? body.contents ?? (Array.isArray(body.input) ? body.input : []);
  const users = history.filter(entry => entry?.role === 'user');
  return users.length >= 2 ? crypto.createHash('sha256').update(JSON.stringify(users[1])).digest('hex') : null;
}

/** Measurement only: the body is never changed. */
export interface ToolStats {
  /** Tool definitions listed in the request. */
  count: number;
  /** Of those, the ones marked to stay out of the context until the model searches for them. */
  deferred: number;
  /** Rough size of the definitions that do enter the context (JSON characters / 4). */
  tokEst: number;
}

// Coding tools inject context as blocks wrapped in one tag (<system-reminder>…</system-reminder>,
// <ide_opened_file>…</ide_opened_file>, <environment_context>…</environment_context>).
const INJECTED_BLOCK = /^\s*<([A-Za-z][\w-]*)[^>]*>[\s\S]*<\/\1>\s*$/;

// A slash command runs the tool's own workflow; its text is not something the person said about the task, so
// the conversation memory leaves it out. Claude Code marks the expanded command with these tags; a client that
// sends the command literally starts with a bare token (`/review add x`, `/plugin:plan`, `/help`) — never a
// path (`/Users/me/a.ts`) or a number (`/2`).
const COMMAND_MARKER = /<command-(?:name|message)>/;
const LITERAL_COMMAND = /^\/[A-Za-z][\w-]*(?::[\w-]+)?(?:\s|$)/;

/**
 * What the person typed, from the text parts of one user entry: the last part that is not one injected
 * tag-wrapped block. Null for a slash command. Shared by the format modules (the conversation memory reads it).
 */
export function typedText(texts: string[]): string | null {
  if (texts.some(text => COMMAND_MARKER.test(text))) return null;
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i].trim();
    if (text && !INJECTED_BLOCK.test(text)) return LITERAL_COMMAND.test(text) ? null : text;
  }
  return null;
}
