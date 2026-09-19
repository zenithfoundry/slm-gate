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

export interface WireFormatModule<L = any> {
  listToolResults(body: JsonObject): ToolResult<L>[];
  /** Returns a new body with only that one text replaced; the input is never modified. */
  replaceToolResultText(params: { body: JsonObject; location: L; text: string }): JsonObject;
}
