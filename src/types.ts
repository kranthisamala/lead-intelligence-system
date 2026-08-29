/**
 * Shared domain types. Kept in one place so the pipeline stages
 * (load -> normalize -> score -> enrich -> report) have a single contract.
 */

/** A raw CSV row, straight from the file. Every value is a string. */
export type RawRow = Record<string, string>;

/** A lead after normalization: missing/garbage values become `undefined`. */
export interface Lead {
  /** Synthetic, stable within a run. Used to merge LLM output back on. */
  id: string;
  name?: string;
  company?: string;
  companySize?: number;
  industry?: string;
  source?: string;
  lastInteractionDate?: Date;
  /** The original date string, kept for the report even when unparseable. */
  lastInteractionRaw?: string;
  /** Machine-readable data-quality tags, e.g. `missing_company_size`. */
  edgeCaseFlags: string[];
  /** Which input file this row came from — useful when files are merged. */
  origin?: string;
}

export type Decision = 'qualified' | 'review' | 'rejected' | 'insufficient_data';

/** The five rubric factors, each on a 1-10 scale. */
export interface SubScores {
  company_size: number;
  industry_fit: number;
  source_quality: number;
  recency: number;
  data_completeness: number;
}

export type FactorKey = keyof SubScores;

export interface OutreachMessage {
  /** Short label for the angle taken, e.g. "problem-led" / "peer-proof". */
  variant: string;
  text: string;
}

/** A lead after the rules engine has run. No LLM output yet. */
export interface ScoredLead extends Lead {
  scores: SubScores;
  /** score x weight per factor — this is what `primaryRejectionReason` ranks. */
  weightedContributions: Record<FactorKey, number>;
  compositeScore: number;
  decision: Decision;
  /** Human-readable trace of any hard filter that changed the decision. */
  decisionNotes: string[];
  /** Weakest factor, mapped to a business label. Drives the aggregate stats. */
  primaryRejectionReason?: string;
  priorityRank?: number;
  priorityTier?: string;
}

/** A scored lead plus the generated prose. This is what lands in the report. */
export interface EnrichedLead extends ScoredLead {
  reasoning: string;
  borderlineNote?: string;
  outreachMessages: OutreachMessage[];
  /** Whether the prose came from the model or the deterministic fallback. */
  commentarySource: 'llm' | 'template';
}

export interface RejectionReasonStat {
  reason: string;
  count: number;
}

export interface RunReport {
  run_summary: {
    input_file: string;
    total_leads: number;
    timestamp: string;
    llm_enabled: boolean;
    model_used: string;
  };
  aggregated_stats: {
    total_processed: number;
    qualified_count: number;
    qualified_pct: number;
    review_count: number;
    review_pct: number;
    rejected_count: number;
    rejected_pct: number;
    insufficient_data_count: number;
    common_rejection_reasons: RejectionReasonStat[];
  };
  /** Ranked, with outreach messages ready to send. */
  qualified: Array<{
    rank: number;
    tier: string;
    id: string;
    name?: string;
    company?: string;
    score: number;
    reasoning: string;
    outreach_messages: OutreachMessage[];
  }>;
  /** Too close to call automatically — ranked, needs a human decision. */
  review: Array<{
    rank: number;
    id: string;
    name?: string;
    company?: string;
    score: number;
    reason: string;
  }>;
  /** Scored and judged a bad fit. No rank: nothing to prioritize for a lead you're not calling. */
  rejected: Array<{
    id: string;
    name?: string;
    company?: string;
    score: number;
    reason: string;
  }>;
  /** Too little data to judge at all — distinct from `rejected`, which means we judged it and it's a bad fit. */
  insufficient: Array<{
    id: string;
    name?: string;
    company?: string;
    /** Which CSV columns were blank/unusable for this row, e.g. ["company_size", "industry"]. */
    missing_fields: string[];
  }>;
}
