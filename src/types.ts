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
  run_metadata: {
    timestamp: string;
    input_file: string;
    total_leads: number;
    reference_date: string;
    llm_enabled: boolean;
    provider: string;
    model_used: string;
    batches_attempted: number;
    batches_failed: number;
    leads_with_template_fallback: number;
    run_duration_ms: number;
  };
  summary_stats: {
    total_processed: number;
    qualified_count: number;
    qualified_pct: number;
    review_count: number;
    review_pct: number;
    rejected_count: number;
    rejected_pct: number;
    insufficient_data_count: number;
    avg_score: number;
    avg_score_qualified: number;
    common_rejection_reasons: RejectionReasonStat[];
    edge_cases_detected: RejectionReasonStat[];
    estimated_analyst_hours_saved: number;
  };
  priority_queue: Array<{
    priority_rank: number;
    priority_tier: string;
    id: string;
    name?: string;
    company?: string;
    composite_score: number;
    headline_reason: string;
  }>;
  flagged_for_review: Array<{
    id: string;
    name?: string;
    company?: string;
    composite_score: number;
    why_borderline: string;
  }>;
  disqualified: Array<{
    id: string;
    name?: string;
    company?: string;
    composite_score: number;
    decision: Decision;
    primary_reason: string;
  }>;
  sample_outreach_messages: Array<{
    lead: string;
    company?: string;
    variant: string;
    message: string;
  }>;
  leads: Array<Record<string, unknown>>;
}
