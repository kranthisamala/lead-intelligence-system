/**
 * Assembles output_report.json, the priority-queue CSV, and the console
 * summary — written for a sales team to act on, not just a developer.
 * Also holds Logger, the small dual-sink (console + output/run.log) logger
 * used across the pipeline.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from './config';
import { toIsoDate } from './dataLoader';
import { REASON_LABELS } from './rubric';
import { EnrichedLead, RejectionReasonStat, RunReport } from './types';

/** Minutes a rep spends manually qualifying one lead, per the brief (8-12). */
const MANUAL_MINUTES_PER_LEAD = 10;

// --- Logger ------------------------------------------------------------

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/** Dual-sink logger: readable console output + a timestamped output/run.log trace. */
export class Logger {
  private readonly stream: fs.WriteStream;
  /** Warnings/errors are re-printed in the run summary so they are not missed. */
  readonly alerts: string[] = [];

  constructor(logPath: string, private readonly quiet = false) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.stream = fs.createWriteStream(logPath, { flags: 'a' });
    this.stream.write(`\n${'='.repeat(72)}\nRUN STARTED ${new Date().toISOString()}\n`);
  }

  private write(level: LogLevel, message: string): void {
    this.stream.write(`[${new Date().toISOString()}] ${level.padEnd(5)} ${message}\n`);
  }

  info(message: string): void {
    this.write('INFO', message);
    if (!this.quiet) console.log(`  ${message}`);
  }

  /** Console-only progress line — keeps run.log free of UI noise. */
  step(message: string): void {
    this.write('INFO', message);
    if (!this.quiet) console.log(`\n${message}`);
  }

  warn(message: string): void {
    this.write('WARN', message);
    this.alerts.push(`WARN  ${message}`);
    if (!this.quiet) console.warn(`  ! ${message}`);
  }

  error(message: string): void {
    this.write('ERROR', message);
    this.alerts.push(`ERROR ${message}`);
    console.error(`  x ${message}`);
  }

  close(): void {
    this.stream.write(`RUN FINISHED ${new Date().toISOString()}\n`);
    this.stream.end();
  }
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function tally(values: string[]): RejectionReasonStat[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Picks message samples from *different* leads so the variety is visible. */
function pickSamples(leads: EnrichedLead[], limit: number) {
  const qualified = leads
    .filter((l) => l.decision === 'qualified' && l.outreachMessages.length > 0)
    .sort((a, b) => (a.priorityRank ?? 0) - (b.priorityRank ?? 0));

  const samples: RunReport['sample_outreach_messages'] = [];
  // Alternate the variant taken from each lead so the samples show both angles.
  for (let i = 0; i < qualified.length && samples.length < limit; i++) {
    const lead = qualified[i];
    const message = lead.outreachMessages[i % lead.outreachMessages.length];
    samples.push({
      lead: lead.name ?? lead.id,
      company: lead.company,
      variant: message.variant,
      message: message.text,
    });
  }
  return samples;
}

export interface ReportInputs {
  leads: EnrichedLead[];
  cfg: AppConfig;
  inputFile: string;
  referenceDate: Date;
  llmEnabled: boolean;
  modelUsed: string;
  batchesAttempted: number;
  batchesFailed: number;
  templateFallbacks: number;
  durationMs: number;
}

export function buildReport(input: ReportInputs): RunReport {
  const { leads, cfg } = input;
  const total = leads.length;

  const qualified = leads.filter((l) => l.decision === 'qualified');
  const review = leads.filter((l) => l.decision === 'review');
  const rejected = leads.filter((l) => l.decision === 'rejected');
  const insufficient = leads.filter((l) => l.decision === 'insufficient_data');

  const avg = (xs: EnrichedLead[]) =>
    xs.length === 0 ? 0 : round1(xs.reduce((s, l) => s + l.compositeScore, 0) / xs.length);

  // "Common rejection reasons" covers everything we are NOT pursuing outright,
  // which is what a sales lead actually wants to see trends in.
  const notPursued = [...rejected, ...insufficient, ...review];

  return {
    run_metadata: {
      timestamp: new Date().toISOString(),
      input_file: input.inputFile,
      total_leads: total,
      reference_date: toIsoDate(input.referenceDate),
      llm_enabled: input.llmEnabled,
      provider: cfg.llm.provider,
      model_used: input.llmEnabled ? input.modelUsed : 'none (rule-based + templates)',
      batches_attempted: input.batchesAttempted,
      batches_failed: input.batchesFailed,
      leads_with_template_fallback: input.templateFallbacks,
      run_duration_ms: input.durationMs,
    },

    summary_stats: {
      total_processed: total,
      qualified_count: qualified.length,
      qualified_pct: pct(qualified.length, total),
      review_count: review.length,
      review_pct: pct(review.length, total),
      rejected_count: rejected.length,
      rejected_pct: pct(rejected.length, total),
      insufficient_data_count: insufficient.length,
      avg_score: avg(leads),
      avg_score_qualified: avg(qualified),
      common_rejection_reasons: tally(
        notPursued.map((l) => l.primaryRejectionReason ?? 'unclassified'),
      ),
      edge_cases_detected: tally(leads.flatMap((l) => l.edgeCaseFlags)),
      estimated_analyst_hours_saved: round1((total * MANUAL_MINUTES_PER_LEAD) / 60),
    },

    priority_queue: qualified
      .slice()
      .sort((a, b) => (a.priorityRank ?? 0) - (b.priorityRank ?? 0))
      .map((l) => ({
        priority_rank: l.priorityRank ?? 0,
        priority_tier: l.priorityTier ?? 'P3',
        id: l.id,
        name: l.name,
        company: l.company,
        composite_score: l.compositeScore,
        headline_reason: l.reasoning,
      })),

    flagged_for_review: review
      .slice()
      .sort((a, b) => (a.priorityRank ?? 0) - (b.priorityRank ?? 0))
      .map((l) => ({
        id: l.id,
        name: l.name,
        company: l.company,
        composite_score: l.compositeScore,
        why_borderline:
          l.borderlineNote ?? (l.decisionNotes.join(' ') || 'Mid-range composite score.'),
      })),

    disqualified: [...rejected, ...insufficient]
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .map((l) => ({
        id: l.id,
        name: l.name,
        company: l.company,
        composite_score: l.compositeScore,
        decision: l.decision,
        primary_reason: l.primaryRejectionReason
          ? (REASON_LABELS[l.primaryRejectionReason] ?? l.primaryRejectionReason)
          : 'Unclassified',
      })),

    sample_outreach_messages: pickSamples(leads, cfg.output.sample_message_count),

    // Full audit trail, one entry per input row, in original file order.
    leads: leads.map((l) => ({
      id: l.id,
      name: l.name ?? null,
      company: l.company ?? null,
      company_size: l.companySize ?? null,
      industry: l.industry ?? null,
      source: l.source ?? null,
      last_interaction_date: l.lastInteractionRaw ?? null,
      source_file: l.origin ?? input.inputFile,
      scores: l.scores,
      weighted_contributions: l.weightedContributions,
      composite_score: l.compositeScore,
      decision: l.decision,
      decision_notes: l.decisionNotes,
      priority_rank: l.priorityRank ?? null,
      priority_tier: l.priorityTier ?? null,
      primary_rejection_reason: l.primaryRejectionReason ?? null,
      edge_case_flags: l.edgeCaseFlags,
      reasoning: l.reasoning,
      borderline_note: l.borderlineNote ?? null,
      outreach_messages: l.outreachMessages,
      commentary_source: l.commentarySource,
    })),
  };
}

export function writeReport(report: RunReport, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
}

/** Escapes a value for CSV: quote it, and double any inner quotes. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

/**
 * A flat priority queue the sales team can open in Excel and work top-down.
 * The JSON report is complete; this is the part they will actually use daily.
 */
export function writePriorityQueueCsv(
  leads: EnrichedLead[],
  outputPath: string,
): void {
  const header = [
    'priority_rank',
    'priority_tier',
    'name',
    'company',
    'industry',
    'company_size',
    'source',
    'last_interaction_date',
    'composite_score',
    'reasoning',
    'outreach_message',
  ];

  const rows = leads
    .filter((l) => l.decision === 'qualified')
    .sort((a, b) => (a.priorityRank ?? 0) - (b.priorityRank ?? 0))
    .map((l) =>
      [
        l.priorityRank,
        l.priorityTier,
        l.name,
        l.company,
        l.industry,
        l.companySize,
        l.source,
        l.lastInteractionRaw,
        l.compositeScore,
        l.reasoning,
        l.outreachMessages[0]?.text ?? '',
      ]
        .map(csvCell)
        .join(','),
    );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, [header.join(','), ...rows].join('\n'), 'utf8');
}

/** The at-a-glance block printed at the end of a run. */
export function printSummary(report: RunReport, alerts: string[]): void {
  const s = report.summary_stats;
  const m = report.run_metadata;
  const line = '─'.repeat(64);

  console.log(`\n${line}`);
  console.log(`  LEAD INTELLIGENCE REPORT — ${m.input_file}`);
  console.log(line);
  console.log(`  Processed          ${s.total_processed} leads in ${(m.run_duration_ms / 1000).toFixed(1)}s`);
  console.log(`  Reference date     ${m.reference_date}   Model: ${m.model_used}`);
  console.log(line);
  console.log(`  Qualified          ${s.qualified_count}  (${s.qualified_pct}%)`);
  console.log(`  Review             ${s.review_count}  (${s.review_pct}%)`);
  console.log(`  Rejected           ${s.rejected_count}  (${s.rejected_pct}%)`);
  console.log(`  Insufficient data  ${s.insufficient_data_count}`);
  console.log(`  Avg score          ${s.avg_score}/10  (qualified: ${s.avg_score_qualified}/10)`);
  console.log(line);
  console.log('  Top reasons leads were not pursued:');
  for (const r of s.common_rejection_reasons.slice(0, 5)) {
    console.log(`    ${String(r.count).padStart(3)}  ${REASON_LABELS[r.reason] ?? r.reason}`);
  }
  console.log(line);
  console.log('  Top of the priority queue:');
  for (const p of report.priority_queue.slice(0, 5)) {
    console.log(
      `    ${p.priority_tier}  #${String(p.priority_rank).padStart(2)}  ${p.composite_score}/10  ` +
        `${p.name ?? '(no name)'} — ${p.company ?? '(no company)'}`,
    );
  }

  if (report.sample_outreach_messages.length > 0) {
    console.log(line);
    const sample = report.sample_outreach_messages[0];
    console.log(`  Sample message (${sample.variant}) to ${sample.lead} at ${sample.company}:`);
    console.log(`    "${sample.message}"`);
  }

  if (m.batches_failed > 0 || m.leads_with_template_fallback > 0) {
    console.log(line);
    console.log(
      `  ! ${m.batches_failed} batch(es) failed; ${m.leads_with_template_fallback} lead(s) fell back to templates.`,
    );
    console.log('    Decisions are unaffected — only the generated prose. See output/run.log.');
  }

  if (alerts.length > 0) {
    console.log(`${line}\n  ${alerts.length} warning(s)/error(s) logged to output/run.log`);
  }
  console.log(`${line}\n`);
}
