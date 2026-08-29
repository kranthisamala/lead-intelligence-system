/**
 * Assembles output_report.json and the console summary — written for a sales
 * team to act on, not just a developer. Also holds Logger, the small
 * dual-sink (console + output/run.log) logger used across the pipeline.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from './config';
import { COMPLETENESS_FIELDS, REASON_LABELS } from './rubric';
import { EnrichedLead, RejectionReasonStat, RunReport } from './types';

/** Internal field name -> the actual CSV column name, for reporting what's missing. */
const CSV_COLUMN_NAMES: Record<(typeof COMPLETENESS_FIELDS)[number], string> = {
  name: 'name',
  company: 'company',
  companySize: 'company_size',
  industry: 'industry',
  source: 'source',
  lastInteractionDate: 'last_interaction_date',
};

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

function tally(values: string[]): RejectionReasonStat[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export interface ReportInputs {
  leads: EnrichedLead[];
  cfg: AppConfig;
  inputFile: string;
  llmEnabled: boolean;
  modelUsed: string;
}

export function buildReport(input: ReportInputs): RunReport {
  const { leads } = input;
  const total = leads.length;

  const qualified = leads.filter((l) => l.decision === 'qualified');
  const review = leads.filter((l) => l.decision === 'review');
  const rejected = leads.filter((l) => l.decision === 'rejected');
  const insufficient = leads.filter((l) => l.decision === 'insufficient_data');

  // "Common rejection reasons" covers everything we are NOT pursuing outright,
  // which is what a sales lead actually wants to see trends in.
  const notPursued = [...rejected, ...insufficient, ...review];

  return {
    run_summary: {
      input_file: input.inputFile,
      total_leads: total,
      timestamp: new Date().toISOString(),
      llm_enabled: input.llmEnabled,
      model_used: input.llmEnabled ? input.modelUsed : 'none (rule-based + templates)',
    },

    aggregated_stats: {
      total_processed: total,
      qualified_count: qualified.length,
      qualified_pct: pct(qualified.length, total),
      review_count: review.length,
      review_pct: pct(review.length, total),
      rejected_count: rejected.length,
      rejected_pct: pct(rejected.length, total),
      insufficient_data_count: insufficient.length,
      common_rejection_reasons: tally(
        notPursued.map((l) => l.primaryRejectionReason ?? 'unclassified'),
      ),
    },

    qualified: qualified
      .slice()
      .sort((a, b) => (a.priorityRank ?? 0) - (b.priorityRank ?? 0))
      .map((l) => ({
        rank: l.priorityRank ?? 0,
        tier: l.priorityTier ?? 'P3',
        id: l.id,
        name: l.name,
        company: l.company,
        score: l.compositeScore,
        reasoning: l.reasoning,
        outreach_messages: l.outreachMessages,
      })),

    review: review
      .slice()
      .sort((a, b) => (a.priorityRank ?? 0) - (b.priorityRank ?? 0))
      .map((l) => ({
        rank: l.priorityRank ?? 0,
        id: l.id,
        name: l.name,
        company: l.company,
        score: l.compositeScore,
        reason: l.borderlineNote ?? (l.decisionNotes.join(' ') || 'Mid-range composite score.'),
      })),

    rejected: rejected
      .slice()
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .map((l) => ({
        id: l.id,
        name: l.name,
        company: l.company,
        score: l.compositeScore,
        reason: l.primaryRejectionReason
          ? (REASON_LABELS[l.primaryRejectionReason] ?? l.primaryRejectionReason)
          : 'Unclassified',
      })),

    insufficient: insufficient.map((l) => ({
      id: l.id,
      name: l.name,
      company: l.company,
      missing_fields: COMPLETENESS_FIELDS.filter((f) => l[f] === undefined).map(
        (f) => CSV_COLUMN_NAMES[f],
      ),
    })),
  };
}

export function writeReport(report: RunReport, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
}

/** The at-a-glance block printed at the end of a run. */
export function printSummary(
  report: RunReport,
  alerts: string[],
  runInfo: { durationMs: number; batchesFailed: number; templateFallbacks: number },
): void {
  const s = report.aggregated_stats;
  const m = report.run_summary;
  const line = '─'.repeat(64);

  console.log(`\n${line}`);
  console.log(`  LEAD INTELLIGENCE REPORT — ${m.input_file}`);
  console.log(line);
  console.log(`  Processed          ${s.total_processed} leads in ${(runInfo.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Model              ${m.model_used}`);
  console.log(line);
  console.log(`  Qualified          ${s.qualified_count}  (${s.qualified_pct}%)`);
  console.log(`  Review             ${s.review_count}  (${s.review_pct}%)`);
  console.log(`  Rejected           ${s.rejected_count}  (${s.rejected_pct}%)`);
  console.log(`  Insufficient data  ${s.insufficient_data_count}`);
  console.log(line);
  console.log('  Top reasons leads were not pursued:');
  for (const r of s.common_rejection_reasons.slice(0, 5)) {
    console.log(`    ${String(r.count).padStart(3)}  ${REASON_LABELS[r.reason] ?? r.reason}`);
  }
  console.log(line);
  console.log('  Top of the qualified queue:');
  for (const q of report.qualified.slice(0, 5)) {
    console.log(
      `    ${q.tier}  #${String(q.rank).padStart(2)}  ${q.score}/10  ` +
        `${q.name ?? '(no name)'} — ${q.company ?? '(no company)'}`,
    );
  }

  const top = report.qualified[0];
  if (top?.outreach_messages.length > 0) {
    const msg = top.outreach_messages[0];
    console.log(line);
    console.log(`  Sample message (${msg.variant}) to ${top.name ?? top.id} at ${top.company ?? '(no company)'}:`);
    console.log(`    "${msg.text}"`);
  }

  if (runInfo.batchesFailed > 0 || runInfo.templateFallbacks > 0) {
    console.log(line);
    console.log(
      `  ! ${runInfo.batchesFailed} batch(es) failed; ${runInfo.templateFallbacks} lead(s) fell back to templates.`,
    );
    console.log('    Decisions are unaffected — only the generated prose. See output/run.log.');
  }

  if (alerts.length > 0) {
    console.log(`${line}\n  ${alerts.length} warning(s)/error(s) logged to output/run.log`);
  }
  console.log(`${line}\n`);
}
