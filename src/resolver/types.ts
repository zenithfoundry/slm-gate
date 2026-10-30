/**
 * Types shared by the resolver: an open decision in a skill, where its answer came from, and the resolved
 * item with its evidence.
 */
export type RiskLevel = 'reversible' | 'low' | 'security' | 'destructive';

/** Where an answer came from; 'decision' is a file in the repo's .slm-gate/decisions folder. */
export type SourceKind = 'evidence' | 'convention' | 'self_consistency' | 'unresolved' | 'api' | 'decision' | 'conversation';

export interface OpenDecision {
  id: string;
  question: string;
  kind: string;
}

export interface ResolvedItem {
  id: string;
  question: string;
  answer: string | null;
  confidence: number;
  source: SourceKind;
  evidence?: string;
  options?: string[];
  risk?: RiskLevel;
  /** Printed next to the answer: which decision file, verified by whom and when. */
  provenance?: string;
  /** The decision file this answer relied on (cache dependency). */
  dependency?: { path: string; mtime: number; expiresAt: string | null };
}

export interface EnrichedAskUserItem {
  id: string;
  question: string;
  recommendedAnswer: string | null;
  confidence: number;
  options: string[];
  evidence?: string;
  provenance?: string;
}

export interface AutoAppliedItem {
  id: string;
  question: string;
  answer: string;
  note: string;
  provenance?: string;
}

export interface ResolverOutput {
  autoApplied: AutoAppliedItem[];
  askUser: EnrichedAskUserItem[];
  /** Repository state the answers relied on (decision files, their folder); the conditioning cache checks them. */
  dependencies?: { path: string; mtime: number; expiresAt: string | null }[];
  /** Decision files past their stale_after date, skipped this run. */
  staleDecisions?: string[];
}
