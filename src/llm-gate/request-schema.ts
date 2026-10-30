/**
 * What the model gate relies on in a generation request body, per wire format: the history it distils and
 * folds, the model it records, and the stream flag. Everything else passes through untouched, so a field the
 * gate does not know is never rejected; a body without these gets a 400 at the edge instead of failing deeper in.
 */
import { z } from 'zod';
import type { WireFormat } from './forward.js';

const stream = z.boolean().optional();

const SCHEMAS: Record<WireFormat, z.ZodTypeAny> = {
  anthropic: z.object({ model: z.string().min(1), messages: z.array(z.unknown()), stream }).passthrough(),
  'chat-completions': z.object({ model: z.string().min(1), messages: z.array(z.unknown()), stream }).passthrough(),
  responses: z.object({ model: z.string().min(1), input: z.union([z.string(), z.array(z.unknown())]), stream }).passthrough(),
  // Gemini names the model in the path.
  gemini: z.object({ contents: z.array(z.unknown()) }).passthrough(),
};

/**
 * The one-line reason a generation request body cannot be forwarded, or null when it can.
 *
 * @param params.format The wire format the route resolved to
 * @param params.body The body as parsed JSON; null when it is not a JSON object
 */
export function requestBodyProblem(params: { format: WireFormat; body: unknown }): string | null {
  const { format, body } = params;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'the request body is not a JSON object';
  const result = SCHEMAS[format].safeParse(body);
  if (result.success) return null;
  const issue = result.error.issues[0];
  return `${issue.path.join('.') || 'body'}: ${issue.message}`;
}
