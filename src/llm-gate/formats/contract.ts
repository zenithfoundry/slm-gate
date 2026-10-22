/**
 * @fileoverview The one contract every wire-format module implements for the model gate.
 *
 * Four real formats (Anthropic Messages, Chat Completions, Responses, Gemini) justify this small shared
 * shape; everything else stays local to each format module. Request bodies are plain parsed JSON.
 */

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

/** The typed prompt of a first request that a plain local reply could answer. */
export interface FirstRequestPrompt {
  text: string;
  /** The request offers the model tools (coding tools almost always do). */
  toolsListed: boolean;
}

/** A complete reply the gate sends itself, in the request's wire format. */
export interface LocalReply {
  contentType: string;
  body: string;
}

export interface WireFormatModule<L = any> {
  listToolResults(body: JsonObject): ToolResult<L>[];
  /** Returns a new body with only that one text replaced; the input is never modified. */
  replaceToolResultText(params: { body: JsonObject; location: L; text: string }): JsonObject;
  /**
   * The typed prompt when this is the first request of a conversation and a plain-text reply could
   * end the turn; null when there is an earlier model turn, structured output is demanded, a tool call is
   * forced, or there is no typed text.
   */
  firstRequestPrompt(body: JsonObject): FirstRequestPrompt | null;
  /** A final text reply that ends the turn, streamed (SSE) or as one JSON body. */
  buildLocalReply(params: { text: string; stream: boolean; model: string; usage: { inputTokens: number; outputTokens: number } }): LocalReply;
  /** How many tool definitions the request carries and how many stay out of the context; null when the format has no such notion. */
  toolStats?(body: JsonObject): ToolStats | null;
  /**
   * What the person typed when the latest entry is a user message carrying text and no tool result; null for a
   * tool-result turn, a slash command, or no typed text. Any turn, not only the first (contrast firstRequestPrompt).
   */
  typedTurnText?(body: JsonObject): string | null;
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

// A slash command runs the tool's own workflow, which only the tool's model can do. Claude Code marks the
// expanded command with these tags; a client that sends the command literally starts with a bare token
// (`/review add x`, `/plugin:plan`, `/help`) — never a path (`/Users/me/a.ts`) or a number (`/2`).
const COMMAND_MARKER = /<command-(?:name|message)>/;
const LITERAL_COMMAND = /^\/[A-Za-z][\w-]*(?::[\w-]+)?(?:\s|$)/;

/**
 * What the person typed, from the text parts of the latest user entry: the last part that is not one
 * injected tag-wrapped block. Null for a slash command, which is never answered locally. Shared by the
 * format modules.
 */
export function typedText(texts: string[]): string | null {
  if (texts.some(text => COMMAND_MARKER.test(text))) return null;
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i].trim();
    if (text && !INJECTED_BLOCK.test(text)) return LITERAL_COMMAND.test(text) ? null : text;
  }
  return null;
}
