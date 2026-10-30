/**
 * The parts of Langfuse's API answers that slm-gate reads, as zod schemas, parsed where the answer arrives
 * (the flush, the sync, verify and wipe commands) so an unexpected answer is reported there and not as a
 * crash deeper in. Fields the gate does not read pass through.
 */
import { z } from 'zod';
import { log } from '../log.js';

/** One rejected item of an ingestion answer (the `errors` array of a 207). */
export const ingestionItemError = z.object({
  id: z.string().optional(),
  status: z.number().optional(),
  message: z.string().optional(),
  error: z.unknown().optional(),
}).passthrough();
export type IngestionItemError = z.infer<typeof ingestionItemError>;

/** POST /api/public/ingestion: `errors` names the items of the batch Langfuse refused. */
export const ingestionResponse = z.object({ errors: z.array(ingestionItemError).optional() }).passthrough();
export type IngestionResponse = z.infer<typeof ingestionResponse>;

/** GET /api/public/v2/metrics with one `name` dimension and a count. */
export const metricsCountsResponse = z.object({
  data: z.array(z.object({ name: z.string().nullable().optional(), count_count: z.union([z.string(), z.number()]) }).passthrough()),
}).passthrough();

/** GET /api/public/traces?limit=1: only the total is read. */
export const traceListTotal = z.object({ meta: z.object({ totalItems: z.number() }).passthrough() }).passthrough();

/** One page of a paginated list. */
export const page = <T extends z.ZodTypeAny>(item: T) => z.object({
  data: z.array(item),
  meta: z.object({ totalPages: z.number().optional() }).passthrough().optional(),
}).passthrough();

/**
 * The JSON body of an answer as `schema` describes it. Null when there is no JSON body, or when it has another
 * shape, which is logged under `scope` with the first mismatch.
 */
export async function readJson<T extends z.ZodTypeAny>(params: { res: Response; schema: T; scope: string; what: string }): Promise<z.infer<T> | null> {
  const { res, schema, scope, what } = params;
  const json: unknown = await res.json().catch(() => null);
  if (json === null) return null;
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  log.warn(scope, `Langfuse ${what} answer has an unexpected shape`, { status: res.status, path: issue?.path.join('.') || '(root)', issue: issue?.message });
  return null;
}
