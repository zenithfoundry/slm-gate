/**
 * The Verifier Module for small-language-model-gate.
 *
 * This module is responsible for analyzing the output of the local Small Language Model (SLM)
 * and deciding whether the response is acceptable or if the request must be escalated to the
 * downstream cloud LLM. It acts as a safety and quality gate.
 *
 * It is primarily used by the `llm-gate` routing layer to evaluate the confidence and 
 * structural validity of local inferences before deferring to them.
 *
 * The verification strictness is monotonic (levels 1-5), meaning each level is a superset
 * of the one below it. As the strictness level increases, the likelihood of escalation also increases.
 *
 * Strictness Levels:
 * - Level 1: Escalates if the answer is completely empty.
 * - Level 2: Escalates if the answer fails a provided regex format constraint.
 * - Level 3: Escalates if the answer contains hedging language (e.g., "I'm not sure").
 * - Level 4: Escalates if multiple generated samples disagree with each other.
 * - Level 5: Always escalates to the cloud model (bypasses local SLM entirely).
 */
import { checkAgreement } from '../models/reasoning.js';

export const HEDGING_LEXICON = [
  "i'm not sure",
  "i am not sure",
  "i think",
  "possibly",
  "cannot determine",
  "unclear",
  "it's unclear",
  // The local model cannot see the conversation a coding tool refers to. An answer that says so is a
  // non-answer, never a reply to show the person (seen live: "I don't have context about Part 1").
  "i don't have context",
  "i do not have context",
  "i don't have the context",
  "without more context",
  "could you (?:briefly )?summarize",
  "could you (?:please )?(?:clarify|provide)",
  "what would you like to focus on",
];

const HEDGING_REGEX = new RegExp(`\\b(${HEDGING_LEXICON.join('|')})\\b`, 'i');

export interface VerifyConstraints {
  formatRe?: RegExp;
  nonEmpty?: boolean;
}

export interface VerifyResult {
  escalate: boolean;
  level: number;
  flags: string[];
}

export function verify(
  answer: string,
  samples: string[],
  constraints: VerifyConstraints,
  level: number
): VerifyResult {
  const flags: string[] = [];

  // Level 1: empty or unparseable
  if (level >= 1) {
    if (answer.trim() === '') {
      flags.push('empty');
    }
  }

  // Level 2: fails format constraint
  if (level >= 2) {
    if (constraints.formatRe && !constraints.formatRe.test(answer)) {
      flags.push('format_mismatch');
    }
  }

  // Level 3: hedging language
  if (level >= 3) {
    if (HEDGING_REGEX.test(answer)) {
      flags.push('hedging');
    }
  }

  // Level 4: samples disagree
  if (level >= 4) {
    if (samples.length > 0 && checkAgreement(samples) === null) {
      flags.push('disagreement');
    }
  }

  // Level 5: always escalate
  if (level >= 5) {
    flags.push('always_escalate');
  }

  return {
    escalate: flags.length > 0,
    level,
    flags
  };
}
