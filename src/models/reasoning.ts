import { z } from 'zod';
import { SLM } from './slm.js';
import { roles } from './roles.js';
import { ClassifyCategory } from './types.js';
import { withSlmTimeout } from './helpers.js';
import { CONFIG } from '../config.js';

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

export async function selfConsistency<T>(
  slm: SLM,
  model: string,
  prompt: string,
  schema: z.ZodSchema<T>,
  k: number = 3,
  temperature: number = 0.7
): Promise<T> {
  const promises = Array.from({ length: k }).map(() =>
    withSlmTimeout(slm.generateJSON<T>(model, prompt, schema, temperature), 'selfConsistency', CONFIG.SLM_TIMEOUT_MS).catch(() => null)
  );
  
  const results = await Promise.all(promises);
  const validResults = results.filter((r) => r !== null) as T[];
  
  const agreed = checkAgreement(validResults);
  if (agreed !== null) {
    return agreed;
  }
  
  // Fallback to a temp=0 run if no agreement
  return withSlmTimeout(slm.generateJSON<T>(model, prompt, schema, 0), 'selfConsistency', CONFIG.SLM_TIMEOUT_MS);
}

export async function classify(
  slm: SLM,
  text: string
): Promise<ClassifyCategory> {
  const schema = z.object({
    category: z.enum(['classify', 'extract', 'format', 'boolean', 'short_factual', 'trivial_edit', 'other'])
  });

  const prompt = `Categorize the following user request into exactly one category:
- 'format': Generating, structuring, or converting data to JSON, XML, CSV, or markdown.
- 'other': Math word problems, arithmetic calculations, multi-step reasoning, logic, coding, or complex tasks.
- 'short_factual': Simple direct fact lookup (e.g. "What is the capital of Japan?"). NEVER use for arithmetic or math.
- 'boolean': Answering yes/no or true/false questions.
- 'extract': Extracting specific data spans from provided text.
- 'classify': Classifying items into categories.
- 'trivial_edit': Fixing spelling or grammar.

Rule: Any question requiring arithmetic calculation, word problem math, or multi-step logic MUST be classified as 'other'.

Text: ${text}`;
  
  const result = await withSlmTimeout(slm.generateJSON(roles.gate, prompt, schema, 0), 'classify', CONFIG.SLM_TIMEOUT_MS);
  return result.category;
}

export async function compress(
  slm: SLM,
  text: string
): Promise<string> {
  const schema = z.object({
    compressedText: z.string()
  });

  const prompt = `Compress the following text while maintaining the core meaning.\n\nText: ${text}`;
  
  const result = await withSlmTimeout(slm.generateJSON(roles.gate, prompt, schema, 0), 'compress', CONFIG.SLM_TIMEOUT_MS);
  return result.compressedText;
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
  return withSlmTimeout(
    slm.generateText(
      CONFIG.SLM_GATE_MODEL,
      [{ role: 'user', content: prompt }],
      CONFIG.TEMPERATURE,
      Math.max(128, Math.ceil(wordCount * 0.6))
    ),
    'distill',
    CONFIG.SLM_TIMEOUT_MS
  );
}
