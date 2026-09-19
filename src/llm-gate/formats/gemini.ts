/**
 * @fileoverview Gemini generateContent, for the model gate contract (formats/contract.ts).
 *
 * Tool results are `functionResponse` parts in user contents; Gemini CLI puts the text in
 * `response.output` (other response shapes are left alone). The call is the `functionCall` part with
 * the same id (or, without ids, the latest earlier call of that name). Thought signatures are sibling
 * keys on model parts: parts are never merged, split, reordered or rebuilt, only the one string changes.
 */
import { JsonObject, ToolResult } from './contract.js';

/** contents[content].parts[part].functionResponse.response.output */
export interface GeminiToolResultLocation {
  content: number;
  part: number;
}

export function listToolResults(body: JsonObject): ToolResult<GeminiToolResultLocation>[] {
  const contents: any[] = Array.isArray(body?.contents) ? body.contents : [];
  const callsById = new Map<string, unknown>();
  const lastCallByName = new Map<string, unknown>();
  let lastModel = -1;
  const results: ToolResult<GeminiToolResultLocation>[] = [];

  // One pass in order, so "latest earlier call of that name" means earlier than the response.
  contents.forEach((content, i) => {
    const parts: any[] = Array.isArray(content?.parts) ? content.parts : [];
    if (content?.role === 'model') {
      lastModel = i;
      for (const part of parts) {
        const call = part?.functionCall;
        if (!call) continue;
        if (typeof call.id === 'string') callsById.set(call.id, call.args);
        if (typeof call.name === 'string') lastCallByName.set(call.name, call.args);
      }
      return;
    }
    parts.forEach((part, j) => {
      const response = part?.functionResponse;
      if (typeof response?.response?.output !== 'string') return;
      const name = String(response.name ?? '');
      const callArgs = typeof response.id === 'string' && callsById.has(response.id) ? callsById.get(response.id) : lastCallByName.get(name);
      results.push({ location: { content: i, part: j }, text: response.response.output, toolName: name, callArgs, newTurn: false });
    });
  });

  // Only now is the last model turn known.
  return results.map(result => ({ ...result, newTurn: result.location.content > lastModel }));
}

export function replaceToolResultText(params: { body: JsonObject; location: GeminiToolResultLocation; text: string }): JsonObject {
  const { body, location: { content, part }, text } = params;
  const contents = [...body.contents];
  const parts = [...contents[content].parts];
  const target = parts[part];
  parts[part] = {
    ...target,
    functionResponse: { ...target.functionResponse, response: { ...target.functionResponse.response, output: text } },
  };
  contents[content] = { ...contents[content], parts };
  return { ...body, contents };
}
