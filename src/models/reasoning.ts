/**
 * The prompts the gate puts to its local models, one function per job (shorten a run, check what survived,
 * answer from a chunk, fold a conversation summary, vote on a decision). The prompt wording and the schema
 * that bounds each answer live here, so a model call elsewhere is only a choice of job.
 */
import { z } from 'zod';
import { SLM } from './slm.js';
import { roles } from './roles.js';
import { withSlmTimeout } from './helpers.js';
import { CONFIG } from '../config.js';

/**
 * The majority answer among samples, or null when none has a strict majority: a 1-1-1 split is no agreement,
 * and the caller then falls back to one deterministic run rather than trusting a coin toss.
 */
export function checkAgreement<T>(samples: T[]): T | null {
  if (samples.length === 0) return null;

  const normalize = (val: any): string => {
    if (typeof val === 'string') {
      return val.toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?]$/, '').trim();
    }
    return JSON.stringify(val);
  };

  const counts = new Map<string, { count: number; original: T }>();
  let maxCount = 0;
  let majorityValue: T | null = null;

  for (const sample of samples) {
    const norm = normalize(sample);
    const existing = counts.get(norm) || { count: 0, original: sample };
    existing.count += 1;
    counts.set(norm, existing);

    if (existing.count > maxCount) {
      maxCount = existing.count;
      majorityValue = existing.original;
    }
  }

  const threshold = Math.floor(samples.length / 2) + 1;
  return maxCount >= threshold ? majorityValue : null;
}

/**
 * Asks the same question k times at a sampling temperature and keeps the majority answer: one sampled
 * answer from a small model is a guess, agreement across samples is evidence. The samples run one after
 * another because Ollama serves one request at a time; fired together, the later ones burned their whole
 * timeout waiting in its queue.
 */
export async function selfConsistency<T>(params: {
  slm: SLM;
  model: string;
  prompt: string;
  schema: z.ZodSchema<T>;
  k?: number;
  temperature?: number;
}): Promise<T> {
  const { slm, model, prompt, schema, k = 3, temperature = 0.7 } = params;
  const validResults: T[] = [];
  for (let i = 0; i < k; i++) {
    const result = await withSlmTimeout({ promise: slm.generateJSON<T>({ model: model, prompt: prompt, schema: schema, temperature: temperature }), stage: 'selfConsistency', timeoutMs: CONFIG.SLM_TIMEOUT_MS }).catch(() => null);
    if (result !== null) validResults.push(result);
  }
  
  const agreed = checkAgreement(validResults);
  if (agreed !== null) {
    return agreed;
  }
  
  // Fallback to a temp=0 run if no agreement
  return withSlmTimeout({ promise: slm.generateJSON<T>({ model: model, prompt: prompt, schema: schema, temperature: 0 }), stage: 'selfConsistency', timeoutMs: CONFIG.SLM_TIMEOUT_MS });
}

/**
 * The fidelity check for one shortened prose run, the heart of the skill fidelity guard: the brain model answers, for each requirement
 * sentence the CODE listed from the original, whether the shortened text still states it. The model never
 * writes the list, so it cannot leave anything out; the schema pins the answer count. One call, the standard
 * ceiling, SLM_TIMEOUT_MS.
 */
export async function checkKept(params: { slm: SLM; inventory: string[]; compressed: string }): Promise<boolean[]> {
  const { slm, inventory, compressed } = params;
  const schema = z.object({ kept: z.array(z.boolean()).length(inventory.length) });
  const prompt = `A text was shortened. For each numbered sentence of the ORIGINAL, answer true only if the SHORTENED text still states it: the same instruction, name, number or path. Answer false when it is missing, weakened or changed. Return exactly ${inventory.length} answers, in order.

ORIGINAL sentences:
${inventory.map((sentence, i) => `${i + 1}. ${sentence}`).join('\n')}

SHORTENED text:
${compressed}`;
  const result = await withSlmTimeout({ promise: slm.generateJSON({ model: roles.brain, prompt: prompt, schema: schema, temperature: 0 }), stage: 'fidelity', timeoutMs: CONFIG.SLM_TIMEOUT_MS });
  return result.kept;
}

/**
 * Answers a question from one chunk of an elided original (`ask_elision`, ask_elision): the brain model says
 * whether the chunk holds the answer and gives it in a few sentences, with the chunk-relative lines it used.
 * One call per chunk, the standard ceiling, SLM_TIMEOUT_MS; the schema bounds the answer.
 */
export async function answerFromText(params: { slm: SLM; question: string; text: string; context?: string | null }): Promise<{ found: boolean; answer: string; lines: [number, number] | null }> {
  const { slm, question, text, context } = params;
  const schema = z.object({
    found: z.boolean(),
    answer: z.string().max(1200),
    lines: z.array(z.number().int().min(0)).length(2).nullable(),
  });
  // Conversation memory (when a usable one exists): what the conversation is about, so a question such as
  // "which step applies here?" has a here. Never a system entry; part of this one prompt.
  const conversation = context ? `Conversation so far:\n${context}\n\n` : '';
  const prompt = `${conversation}Answer the question ONLY from the TEXT below. If the text does not contain the answer, set found to false and leave answer empty. Keep the answer under 80 words; quote names, numbers, paths and commands exactly. "lines" is the 0-based [first, last] line of the text the answer comes from, or null.

QUESTION: ${question}

TEXT:
${text}`;
  const result = await withSlmTimeout({ promise: slm.generateJSON({ model: roles.brain, prompt: prompt, schema: schema, temperature: 0 }), stage: 'ask_elision', timeoutMs: CONFIG.SLM_TIMEOUT_MS });
  return { found: result.found, answer: result.answer, lines: result.lines ? [result.lines[0], result.lines[1]] : null };
}

/** The three parts of a conversation summary, bounded in the schema so the brain cannot run long. */
export const MEMORY_SCHEMA = z.object({
  goal: z.string().max(300),
  decided: z.array(z.string().max(160)).max(8),
  inPlay: z.array(z.string().max(80)).max(12),
});
export type MemorySummary = z.infer<typeof MEMORY_SCHEMA>;

/**
 * Folds new conversation entries into the running summary (conversation memory). The brain reads the previous
 * summary plus only the new entries, never the whole history, and answers in the three parts. One call, the
 * standard ceiling, SLM_TIMEOUT_MS; the schema's limits make an over-long answer fail validation.
 */
export async function foldSummary(params: { slm: SLM; previous: MemorySummary | null; fresh: string }): Promise<MemorySummary> {
  const { slm, previous, fresh } = params;
  const prompt = `You keep a short memory of a conversation for a reader who has not seen it. Update it from the NEW TURNS.
Rules: copy names, numbers, paths and commands exactly; keep every earlier "decided" line unless the new turns reverse it; "inPlay" lists files, commands and names that keep coming up; short lines, no prose.

PREVIOUS MEMORY:
${previous ? JSON.stringify(previous) : '(none yet)'}

NEW TURNS:
${fresh}`;
  return withSlmTimeout({ promise: slm.generateJSON({ model: roles.brain, prompt: prompt, schema: MEMORY_SCHEMA, temperature: 0 }), stage: 'memory', timeoutMs: CONFIG.SLM_TIMEOUT_MS });
}

/**
 * Compresses ONE narrative run for `distillToolResult`, which never sends protected content here, so
 * this prompt carries no placeholder-custody rules — a 3B model reliably summarises prose and reliably
 * loses opaque tokens. An explicit word budget is what actually drives the ratio: without it the model
 * rewords instead of condensing (measured 4-8% vs 44-60%). Shared by the MCP layer and the model gate.
 *
 * @param params.slm The local model client
 * @param params.text The narrative run to compress
 * @param params.task Optional task context for the model
 * @returns The compressed run
 */
export function compressNarrativeRun(params: { slm: SLM; text: string; task?: string }): Promise<string> {
  const { slm, text, task } = params;
  const wordCount = text.trim().split(/\s+/).length;
  const targetWords = Math.max(20, Math.ceil(wordCount * 0.35));
  const prompt = `Compress the text below to AT MOST ${targetWords} words.\n\nKeep: every instruction, requirement, constraint, name, number, path and technical specific.\nDelete: background, history, rationale, motivation, repetition and filler.\nOutput ONLY the compressed text as terse bullet points. No preamble, no heading.\n\nTask context: ${task || 'None'}\n\n${text}`;
  // This was the only model call in the pipeline with neither a token ceiling nor a timeout.
  // Ollama sends HTTP response headers only AFTER generation completes, so the effective cap
  // is Node fetch's 300s header timeout surfacing as `fetch failed`, misclassified as a
  // transport error, long after the MCP client had given up. SLM_TIMEOUT_MS now governs it.
  // The ceiling is per-run and generous against the target so a summary is never cut mid-
  // sentence; the run is discarded anyway if it comes back longer than the original.
  return withSlmTimeout({
    promise: slm.generateText({
      model: CONFIG.SLM_GATE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: CONFIG.TEMPERATURE,
      maxTokens: Math.max(128, Math.ceil(wordCount * 0.6))
    }),
    stage: 'distill',
    timeoutMs: CONFIG.SLM_TIMEOUT_MS
  });
}
