/**
 * All scoring logic — pure functions, no API calls. Qualify/review/reject is
 * decided ENTIRELY here, deterministically; the LLM never votes on it.
 */
import { AppConfig } from './config';
import { Decision, FactorKey, Lead, ScoredLead, SubScores } from './types';

const MS_PER_DAY = 86_400_000;

type Band = { max: number | null; score: number };

/** First band whose `max` the value fits into wins; `max: null` is the catch-all. */
function scoreByBand(value: number, bands: Band[]): number {
  for (const band of bands) {
    if (band.max === null || value <= band.max) return band.score;
  }
  return bands[bands.length - 1].score;
}

// --- Factor 1: company size -------------------------------------------------
export function scoreCompanySize(size: number | undefined, cfg: AppConfig): number {
  if (size === undefined) return cfg.company_size_missing_score;
  return scoreByBand(size, cfg.company_size_bands);
}

// --- Factor 2: industry fit -------------------------------------------------
/** Case- and whitespace-insensitive so "saas" and "SaaS " both hit tier A. */
function inTier(industry: string, tier: string[]): boolean {
  const needle = industry.trim().toLowerCase();
  return tier.some((t) => t.trim().toLowerCase() === needle);
}

export function scoreIndustry(industry: string | undefined, cfg: AppConfig): number {
  const t = cfg.industry_tiers;
  if (!industry) return t.unknown_score;
  if (inTier(industry, t.tier_a)) return t.tier_a_score;
  if (inTier(industry, t.tier_b)) return t.tier_b_score;
  if (inTier(industry, t.tier_c)) return t.tier_c_score;
  return t.unknown_score; // unmapped industry: neutral, not penalised
}

// --- Factor 3: source quality ----------------------------------------------
export function scoreSource(source: string | undefined, cfg: AppConfig): number {
  if (!source) return cfg.source_scores.default;
  const needle = source.trim().toLowerCase();
  for (const [key, value] of Object.entries(cfg.source_scores)) {
    if (key !== 'default' && key.trim().toLowerCase() === needle) return value;
  }
  return cfg.source_scores.default;
}

// --- Factor 4: recency ------------------------------------------------------
export function daysSince(date: Date, referenceDate: Date): number {
  return Math.floor((referenceDate.getTime() - date.getTime()) / MS_PER_DAY);
}

export function scoreRecency(
  date: Date | undefined,
  referenceDate: Date,
  cfg: AppConfig,
): number {
  if (!date) return cfg.recency_missing_score;
  const days = daysSince(date, referenceDate);
  // A date *after* the reference date (data-entry error, or a pinned reference
  // date in the past) is treated as maximally recent rather than as an error.
  if (days < 0) return cfg.recency_bands[0].score;
  return scoreByBand(days, cfg.recency_bands);
}

// --- Factor 5: data completeness -------------------------------------------
/** The six fields the sales team needs to act on a lead. */
export const COMPLETENESS_FIELDS = [
  'name',
  'company',
  'companySize',
  'industry',
  'source',
  'lastInteractionDate',
] as const;

export function scoreCompleteness(lead: Lead): number {
  const present = COMPLETENESS_FIELDS.filter(
    (f) => lead[f] !== undefined && lead[f] !== null,
  ).length;
  return round1((present / COMPLETENESS_FIELDS.length) * 10);
}

// --- Composite --------------------------------------------------------------
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function weightedContributions(
  scores: SubScores,
  cfg: AppConfig,
): Record<FactorKey, number> {
  return {
    company_size: scores.company_size * cfg.weights.company_size,
    industry_fit: scores.industry_fit * cfg.weights.industry_fit,
    source_quality: scores.source_quality * cfg.weights.source_quality,
    recency: scores.recency * cfg.weights.recency,
    data_completeness: scores.data_completeness * cfg.weights.data_completeness,
  };
}

export function computeComposite(scores: SubScores, cfg: AppConfig): number {
  const contributions = weightedContributions(scores, cfg);
  return round1(Object.values(contributions).reduce((a, b) => a + b, 0));
}

// --- Decision ---------------------------------------------------------------
export interface DecisionResult {
  decision: Decision;
  notes: string[];
}

/**
 * Composite -> decision, then hard filters. Filters can only *downgrade* to
 * "review", never promote — for cases where a high composite is misleading
 * (e.g. a 3-person startup scoring well on everything but size).
 */
export function decide(
  lead: Lead,
  scores: SubScores,
  composite: number,
  cfg: AppConfig,
): DecisionResult {
  const t = cfg.decision_thresholds;
  const notes: string[] = [];

  // Gate 1 — can we even identify or evaluate this lead?
  if (lead.edgeCaseFlags.includes('no_identifier')) {
    return {
      decision: 'insufficient_data',
      notes: ['No name and no company: nothing to contact. Sent for data enrichment.'],
    };
  }
  if (scores.data_completeness <= t.insufficient_data_completeness_max) {
    return {
      decision: 'insufficient_data',
      notes: [
        `Only ${Math.round((scores.data_completeness / 10) * COMPLETENESS_FIELDS.length)} of ` +
          `${COMPLETENESS_FIELDS.length} fields present: too little to judge fit. Sent for data enrichment.`,
      ],
    };
  }

  // Gate 2 — the composite score.
  let decision: Decision =
    composite >= t.qualified_min ? 'qualified' : composite >= t.review_min ? 'review' : 'rejected';

  // Gate 3 — hard filters, downgrade-only.
  if (decision === 'qualified') {
    const hf = cfg.hard_filters;
    if (lead.companySize === undefined && hf.require_known_company_size) {
      decision = 'review';
      notes.push(
        'Company size unknown — the heaviest rubric factor could not be verified, so this is not auto-qualified.',
      );
    } else if (lead.companySize !== undefined && lead.companySize < hf.min_company_size_for_qualified) {
      decision = 'review';
      notes.push(
        `Only ${lead.companySize} employees (floor for auto-qualification is ${hf.min_company_size_for_qualified}) — ` +
          'scores well on intent but is below our pricing floor. Human call.',
      );
    } else if (lead.companySize !== undefined && lead.companySize > hf.max_company_size_for_qualified) {
      decision = 'review';
      notes.push(
        `${lead.companySize.toLocaleString()} employees — above the ${hf.max_company_size_for_qualified.toLocaleString()} ` +
          'ceiling for this motion. Route to enterprise sales rather than the standard sequence.',
      );
    }
  }

  return { decision, notes };
}

// --- Why was this lead weak? ------------------------------------------------
/** Points a factor *cost* the lead: (10 - score) x weight. Perfect score = 0. */
export function weightedShortfalls(scores: SubScores, cfg: AppConfig): Record<FactorKey, number> {
  return {
    company_size: (10 - scores.company_size) * cfg.weights.company_size,
    industry_fit: (10 - scores.industry_fit) * cfg.weights.industry_fit,
    source_quality: (10 - scores.source_quality) * cfg.weights.source_quality,
    recency: (10 - scores.recency) * cfg.weights.recency,
    data_completeness: (10 - scores.data_completeness) * cfg.weights.data_completeness,
  };
}

/**
 * The factor that cost this lead the most points, mapped to a business
 * label. Ranked by SHORTFALL (points lost), not raw contribution — otherwise
 * a perfect 10/10 on a low-weight factor could still get blamed over a
 * mediocre score on a heavier one.
 */
export function primaryRejectionReason(lead: Lead, scores: SubScores, cfg: AppConfig): string {
  const shortfalls = weightedShortfalls(scores, cfg);
  const weakest = (Object.entries(shortfalls) as Array<[FactorKey, number]>).sort(
    (a, b) => b[1] - a[1],
  )[0][0];

  switch (weakest) {
    case 'company_size': {
      if (lead.companySize === undefined) return 'company_size_unknown';
      return lead.companySize < 50 ? 'company_too_small' : 'company_too_large';
    }
    case 'industry_fit':
      return lead.industry ? 'poor_industry_fit' : 'industry_unknown';
    case 'source_quality':
      return 'low_intent_source';
    case 'recency':
      return lead.lastInteractionDate ? 'stale_engagement' : 'no_recorded_interaction';
    case 'data_completeness':
      return 'incomplete_data';
  }
}

/** Human-readable labels for the reason tags, used in the report and prompts. */
export const REASON_LABELS: Record<string, string> = {
  company_too_small: 'Company below our size floor',
  company_too_large: 'Company above our mid-market ceiling',
  company_size_unknown: 'Company size unknown',
  poor_industry_fit: 'Industry outside our target segments',
  industry_unknown: 'Industry unknown',
  low_intent_source: 'Low-intent lead source',
  stale_engagement: 'Engagement has gone stale',
  no_recorded_interaction: 'No recorded interaction date',
  incomplete_data: 'Incomplete lead record',
};

// --- Orchestration for one lead --------------------------------------------
export function scoreLead(lead: Lead, referenceDate: Date, cfg: AppConfig): ScoredLead {
  const scores: SubScores = {
    company_size: scoreCompanySize(lead.companySize, cfg),
    industry_fit: scoreIndustry(lead.industry, cfg),
    source_quality: scoreSource(lead.source, cfg),
    recency: scoreRecency(lead.lastInteractionDate, referenceDate, cfg),
    data_completeness: scoreCompleteness(lead),
  };

  const composite = computeComposite(scores, cfg);
  const { decision, notes } = decide(lead, scores, composite, cfg);

  const contributions = weightedContributions(scores, cfg);
  const rounded = Object.fromEntries(
    Object.entries(contributions).map(([k, v]) => [k, round1(v)]),
  ) as Record<FactorKey, number>;

  return {
    ...lead,
    scores,
    weightedContributions: rounded,
    compositeScore: composite,
    decision,
    decisionNotes: notes,
    // An `insufficient_data` lead is always reported as such: the shortfall
    // ranking would otherwise blame whichever field happened to be missing,
    // when the real answer is "we don't know enough about this record at all".
    primaryRejectionReason:
      decision === 'qualified'
        ? undefined
        : decision === 'insufficient_data'
          ? 'incomplete_data'
          : primaryRejectionReason(lead, scores, cfg),
  };
}

/**
 * Ranks each bucket independently: qualified leads get the working priority
 * queue (rank 1 = call first), review leads get their own ordering so the
 * human triage list is also sorted by potential value.
 */
export function assignPriority(leads: ScoredLead[], cfg: AppConfig): ScoredLead[] {
  const rank = (bucket: ScoredLead[]) => {
    bucket
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .forEach((lead, i) => {
        lead.priorityRank = i + 1;
        lead.priorityTier =
          lead.decision === 'qualified'
            ? (cfg.priority_tiers.find((t) => lead.compositeScore >= t.min)?.tier ?? 'P3')
            : undefined;
      });
  };

  rank(leads.filter((l) => l.decision === 'qualified'));
  rank(leads.filter((l) => l.decision === 'review'));
  return leads;
}
