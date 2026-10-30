/**
 * @fileoverview Decision memory for the resolver.
 *
 * The resolver finds open questions in a skill ("API-first or UI-first?") and answers them from the repository.
 * This module lets the owner answer once, in a file, so the same question is never asked twice in that repo:
 *
 *   .slm-gate/decisions/<name>.md
 *   ---
 *   type: Decision
 *   title: Architecture direction
 *   verified_by: human:bz3b
 *   verified_at: 2026-10-21
 *   stale_after: 2027-04-01
 *   ---
 *   API-first. The MCP protocol and the four wire formats are the product boundary.
 *
 * A decision file is EVIDENCE, not an instruction: a match enters `resolveEach` where a file read enters today
 * and still passes `gateDecisions`, the risk gate, so a security or destructive question is never auto-applied
 * from a file. Confidence is 0.9 only when a human verified the file and it is not past `stale_after`; otherwise
 * 0.5, which lands the answer under "Pending Clarifications" as a recommendation. Provenance (file, who, when)
 * is printed next to every answer. Matching is FTS5 over title and body (ledger `decisions_fts`, re-indexed when
 * a file's mtime changes); one brain call confirms the match applies. No embeddings.
 *
 * Cache dependencies: the files used, the directory itself (its mtime changes when a file is added or removed)
 * and the earliest `stale_after` go into `condition_deps`, so a cached conditioning is recomputed when any of
 * them changes (see `cacheDepsFresh`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG } from '../config.js';
import { withSlmTimeout } from '../models/helpers.js';
import { SLM } from '../models/slm.js';
import { CacheDependency, decisionIndexRevision, replaceDecisionIndex, searchDecisions } from '../ledger/index.js';

/** Where a repo keeps its decisions, relative to the repo root. */
export const DECISIONS_DIR = path.join('.slm-gate', 'decisions');

export interface DecisionFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the repo root, as printed in provenance. */
  relPath: string;
  title: string;
  body: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  staleAfter: string | null;
  /** File mtime in whole milliseconds, the cache dependency value. */
  mtime: number;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Parses one decision file: flat `key: value` frontmatter lines and a body. Returns null when the file has no
 * frontmatter or no title, so a stray markdown file in the folder is ignored rather than trusted. Pure.
 */
export function parseDecisionFile(params: { absPath: string; relPath: string; raw: string; mtime: number }): DecisionFile | null {
  const { absPath, relPath, raw, mtime } = params;
  const match = FRONTMATTER.exec(raw.replace(/\r\n/g, '\n'));
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
  }
  if (!fields.title) return null;
  return {
    path: absPath,
    relPath,
    title: fields.title,
    body: match[2].trim(),
    verifiedBy: fields.verified_by || null,
    verifiedAt: fields.verified_at || null,
    staleAfter: fields.stale_after || null,
    mtime: Math.round(mtime),
  };
}

/** A decision past its `stale_after` date is never applied; it is reported so the owner can refresh it. */
export function isStale(decision: DecisionFile, now = new Date()): boolean {
  if (!decision.staleAfter) return false;
  const until = new Date(decision.staleAfter);
  return !Number.isNaN(until.getTime()) && until.getTime() < now.getTime();
}

/** Verified by a person (the owner's direction, recorded once) and still current. */
export function isTrusted(decision: DecisionFile, now = new Date()): boolean {
  return Boolean(decision.verifiedBy && /^human:/i.test(decision.verifiedBy)) && !isStale(decision, now);
}

/** What one resolver run knows about a repo's decisions; built once per run by `loadDecisionMemory`. */
export interface DecisionMemory {
  repoRoot: string;
  decisions: DecisionFile[];
  /** Relative paths of decisions past their stale_after date (skipped, reported in meta). */
  stale: string[];
  /** The directory dependency, present whenever the folder exists. */
  dirDependency: CacheDependency | null;
  /** Finds the best decision for a question, or null. */
  match(question: string): DecisionFile | null;
}

/** The first directory in the list that exists, as a cache dependency; null when none does. */
function nearestExistingDir(candidates: string[]): CacheDependency | null {
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return { path: candidate, mtime: Math.round(stat.mtimeMs), expiresAt: null };
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * Reads `.slm-gate/decisions/*.md` under the repo root and refreshes the FTS index when any file changed.
 * A repo without the folder gets an empty memory: the resolver then behaves exactly as before.
 */
export function loadDecisionMemory(repoRoot: string, now = new Date()): DecisionMemory {
  const dir = path.join(repoRoot, DECISIONS_DIR);
  let entries: string[];
  let dirMtime: number;
  try {
    entries = fs.readdirSync(dir).filter(name => name.endsWith('.md')).sort();
    dirMtime = Math.round(fs.statSync(dir).mtimeMs);
  } catch {
    // No decisions folder. The cached conditioning must still notice when one appears, so depend on the
    // nearest existing ancestor: creating `.slm-gate/decisions` changes `.slm-gate`'s mtime, and creating
    // `.slm-gate` changes the repo root's. A root that cannot be read gives no dependency at all.
    return { repoRoot, decisions: [], stale: [], dirDependency: nearestExistingDir([path.join(repoRoot, '.slm-gate'), repoRoot]), match: () => null };
  }

  const decisions: DecisionFile[] = [];
  for (const name of entries) {
    const absPath = path.join(dir, name);
    try {
      const stat = fs.statSync(absPath);
      const parsed = parseDecisionFile({ absPath, relPath: path.join(DECISIONS_DIR, name), raw: fs.readFileSync(absPath, 'utf8'), mtime: stat.mtimeMs });
      if (parsed) decisions.push(parsed);
    } catch {
      // An unreadable file is skipped, never guessed at.
    }
  }

  // The index revision is the folder's content fingerprint; re-index only when it moved.
  const revision = `${dirMtime}:${decisions.map(d => `${d.relPath}@${d.mtime}`).join(',')}`;
  if (decisionIndexRevision(repoRoot) !== revision) {
    replaceDecisionIndex({ root: repoRoot, revision, rows: decisions.map(d => ({ path: d.relPath, title: d.title, body: d.body })) });
  }

  const stale = decisions.filter(d => isStale(d, now)).map(d => d.relPath);
  const current = decisions.filter(d => !isStale(d, now));
  return {
    repoRoot,
    decisions,
    stale,
    dirDependency: { path: dir, mtime: dirMtime, expiresAt: null },
    match(question: string): DecisionFile | null {
      if (current.length === 0) return null;
      // Several hits, best first: a stale decision may outrank a current one on words alone.
      for (const hit of searchDecisions({ root: repoRoot, query: question, limit: 5 })) {
        const decision = current.find(d => d.relPath === hit.path);
        if (decision) return decision;
      }
      return null;
    },
  };
}

export interface DecisionAnswer {
  answer: string;
  confidence: number;
  provenance: string;
  dependency: CacheDependency;
}

/**
 * Answers one open question from decision memory: FTS match, then one brain call to confirm the decision really
 * answers this question (and to phrase the answer). Null when nothing matches, the brain says it does not apply,
 * or the call fails or times out — the caller then takes today's evidence path.
 */
export async function decisionAnswer(params: { slm: SLM; memory: DecisionMemory; question: string; now?: Date }): Promise<DecisionAnswer | null> {
  const { slm, memory, question, now = new Date() } = params;
  const decision = memory.match(question);
  if (!decision) return null;

  const schema = z.object({ applies: z.boolean(), answer: z.string().max(600) });
  const prompt = `A repository keeps written decisions. Does the DECISION below answer the QUESTION? Set applies to true only when it settles that exact question; then give the answer in one or two sentences using the decision's own words. Otherwise set applies to false and leave answer empty.

QUESTION: ${question}

DECISION "${decision.title}":
${decision.body}`;
  let result: { applies: boolean; answer: string };
  try {
    result = await withSlmTimeout({ promise: slm.generateJSON({ model: CONFIG.SLM_BRAIN_MODEL, prompt: prompt, schema: schema, temperature: 0 }), stage: 'resolver', timeoutMs: CONFIG.SLM_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (!result.applies || !result.answer.trim()) return null;

  const trusted = isTrusted(decision, now);
  const who = decision.verifiedBy ? `verified by ${decision.verifiedBy}${decision.verifiedAt ? ` ${decision.verifiedAt}` : ''}` : 'unverified';
  return {
    answer: result.answer.trim(),
    confidence: trusted ? 0.9 : 0.5,
    provenance: `decision: ${decision.relPath} (${who})`,
    dependency: { path: decision.path, mtime: decision.mtime, expiresAt: decision.staleAfter },
  };
}
