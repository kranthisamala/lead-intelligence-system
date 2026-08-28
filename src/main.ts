/**
 * Pipeline entry point: parses CLI args, then runs load CSV -> normalize ->
 * score -> rank -> enrich with LLM (optional) -> report. Only enrichment
 * touches the network, so `--dry-run` gives the same decisions instantly and
 * at zero cost.
 */
import 'dotenv/config';
import * as path from 'path';
import { AppConfig, loadConfig } from './config';
import { loadCsvs, normalizeAll, resolveReferenceDate, toIsoDate } from './dataLoader';
import { enrichLeads, LlmClient } from './llm';
import { assignPriority, scoreLead } from './rubric';
import { buildReport, Logger, printSummary, writePriorityQueueCsv, writeReport } from './report';

// =============================================================================
// CLI argument parsing (argv -> options; no dependency needed for this surface area)
// =============================================================================

export type Provider = 'groq' | 'openai' | 'gemini';

/** Per-provider defaults for a `--provider` switch. */
const PROVIDER_PRESETS: Record<
  Provider,
  { base_url: string; api_key_env: string; model: string; fallback_model: string | undefined }
> = {
  groq: {
    base_url: 'https://api.groq.com/openai/v1',
    api_key_env: 'GROQ_API_KEY',
    model: 'openai/gpt-oss-120b',
    fallback_model: 'openai/gpt-oss-20b',
  },
  openai: {
    base_url: 'https://api.openai.com/v1',
    api_key_env: 'OPENAI_API_KEY',
    model: 'gpt-4o',
    fallback_model: 'gpt-4o-mini',
  },
  gemini: {
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    api_key_env: 'GEMINI_API_KEY',
    model: 'gemini-2.0-flash',
    fallback_model: undefined,
  },
};

/** Mutates cfg.llm to point at a different provider's defaults. `model` overrides the preset if given. */
export function applyProviderPreset(cfg: AppConfig, provider: Provider, model?: string): void {
  cfg.llm.provider = provider;
  const preset = PROVIDER_PRESETS[provider];
  cfg.llm.base_url = preset.base_url;
  cfg.llm.api_key_env = preset.api_key_env;
  cfg.llm.model = model ?? preset.model;
  cfg.llm.fallback_model = preset.fallback_model;
}

export interface CliOptions {
  input: string[];
  output: string;
  batchSize?: number;
  dryRun: boolean;
  limit?: number;
  provider?: Provider;
  model?: string;
  quiet: boolean;
  help: boolean;
}

export const USAGE = `
Lead Intelligence System — qualify inbound leads and draft outreach.

Usage:
  npm start -- [options]

Options:
  --input <path>       CSV to process. Repeat the flag to merge several files.
                       (default: data/leads.csv)
  --output <path>      Report destination (default: output/output_report.json)
  --batch-size <n>     Leads per LLM call (default: config.yaml llm.batch_size)
  --limit <n>          Only process the first N leads. Useful for a cheap smoke test.
  --provider <name>    Override config.yaml: groq | openai | gemini
  --model <name>       Override the configured model
  --dry-run            Skip the LLM entirely. Rules engine + template prose only.
                       Free, instant, and the fastest way to sanity-check the rubric.
  --quiet              Suppress per-step console output (the summary still prints)
  --help               Show this message

Examples:
  npm start -- --dry-run
  npm start -- --input data/leads.csv
  npm start -- --input data/leads.csv --input data/leads_testing.csv
  npm start -- --limit 10 --batch-size 5
`;

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    input: [],
    output: 'output/output_report.json',
    dryRun: false,
    quiet: false,
    help: false,
  };

  const next = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Option ${flag} requires a value. See --help.`);
    }
    return value;
  };

  const int = (raw: string, flag: string): number => {
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || n <= 0) throw new Error(`Option ${flag} needs a positive integer.`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--input':
      case '-i':
        opts.input.push(next(i, arg));
        i++;
        break;
      case '--output':
      case '-o':
        opts.output = next(i, arg);
        i++;
        break;
      case '--batch-size':
        opts.batchSize = int(next(i, arg), arg);
        i++;
        break;
      case '--limit':
        opts.limit = int(next(i, arg), arg);
        i++;
        break;
      case '--provider': {
        const value = next(i, arg);
        if (value !== 'groq' && value !== 'openai' && value !== 'gemini') {
          throw new Error(`Unknown provider "${value}". Use groq, openai or gemini.`);
        }
        opts.provider = value;
        i++;
        break;
      }
      case '--model':
        opts.model = next(i, arg);
        i++;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option "${arg}". See --help.`);
    }
  }

  if (opts.input.length === 0) opts.input.push('data/leads.csv');
  return opts;
}

// =============================================================================
// Orchestration
// =============================================================================

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const started = Date.now();
  const cfg = loadConfig();

  // CLI overrides win over config.yaml, so a run can be redirected without edits.
  if (opts.batchSize) cfg.llm.batch_size = opts.batchSize;
  if (opts.provider && opts.provider !== cfg.llm.provider) {
    // Also resets model/base_url — config.yaml's model is wrong for a
    // different provider. --model still wins if given.
    applyProviderPreset(cfg, opts.provider, opts.model);
  } else if (opts.model) {
    cfg.llm.model = opts.model;
  } else if (process.env.PROD_MODEL) {
    cfg.llm.model = process.env.PROD_MODEL;
  }

  const log = new Logger(path.join('output', 'run.log'), opts.quiet);

  try {
    // --- 1. Load -------------------------------------------------------------
    log.step('1/5  Loading input');
    const { rows, file } = loadCsvs(opts.input);
    log.info(`Read ${rows.length} row(s) from ${file}`);

    // --- 2. Normalize --------------------------------------------------------
    log.step('2/5  Normalizing and flagging data quality issues');
    let leads = normalizeAll(rows);
    if (opts.limit && opts.limit < leads.length) {
      leads = leads.slice(0, opts.limit);
      log.info(`--limit applied: processing the first ${leads.length} lead(s)`);
    }
    const flagged = leads.filter((l) => l.edgeCaseFlags.length > 0).length;
    log.info(`${flagged} of ${leads.length} lead(s) carry at least one data-quality flag`);

    const referenceDate = resolveReferenceDate(leads, cfg.reference_date);
    log.info(
      `Recency reference date: ${toIsoDate(referenceDate)}` +
        (cfg.reference_date === 'auto' ? ' (auto: newest interaction in the input)' : ' (pinned in config)'),
    );

    // --- 3. Score (no network, fully deterministic) --------------------------
    log.step('3/5  Scoring against the rubric');
    const scored = assignPriority(
      leads.map((lead) => scoreLead(lead, referenceDate, cfg)),
      cfg,
    );
    const counts = scored.reduce<Record<string, number>>((acc, l) => {
      acc[l.decision] = (acc[l.decision] ?? 0) + 1;
      return acc;
    }, {});
    log.info(
      `Decisions: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`,
    );

    // --- 4. Enrich (the only networked step) ---------------------------------
    log.step('4/5  Generating reasoning and outreach copy');
    let client: LlmClient | null = null;
    if (opts.dryRun) {
      log.info('--dry-run: skipping the LLM. Decisions are identical; prose comes from templates.');
    } else if (!LlmClient.hasKey(cfg)) {
      // Missing key is an expected condition, not a crash: warn and degrade.
      log.warn(
        `No ${cfg.llm.api_key_env} found in the environment. Falling back to template prose. ` +
          `Add it to .env for personalized messages, or pass --dry-run to silence this.`,
      );
    } else {
      client = new LlmClient(cfg, log);
    }

    const { leads: enriched, stats } = await enrichLeads(
      scored,
      client,
      cfg,
      log,
      toIsoDate(referenceDate),
    );

    // --- 5. Report -----------------------------------------------------------
    log.step('5/5  Writing report');
    const report = buildReport({
      leads: enriched,
      cfg,
      inputFile: file,
      referenceDate,
      llmEnabled: client !== null,
      modelUsed: client?.activeModel ?? cfg.llm.model,
      batchesAttempted: stats.batchesAttempted,
      batchesFailed: stats.batchesFailed,
      templateFallbacks: stats.templateFallbacks,
      durationMs: Date.now() - started,
    });

    writeReport(report, opts.output);
    log.info(`Report written to ${path.resolve(opts.output)}`);

    if (cfg.output.write_priority_queue_csv) {
      const csvPath = path.join(path.dirname(opts.output), 'priority_queue.csv');
      writePriorityQueueCsv(enriched, csvPath);
      log.info(`Priority queue written to ${path.resolve(csvPath)}`);
    }

    printSummary(report, log.alerts);
    return 0;
  } catch (err) {
    // Anything reaching here is a setup/input problem, not a per-lead problem —
    // per-lead and per-batch failures are all absorbed further down the stack.
    log.error((err as Error).message);
    console.error(`\nRun failed: ${(err as Error).message}\n`);
    if (process.env.DEBUG) console.error((err as Error).stack);
    return 1;
  } finally {
    log.close();
  }
}

// Guarded so test_prompts.ts can import parseArgs/applyProviderPreset from
// this file without triggering a full pipeline run as a side effect.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Unexpected fatal error:', err);
      process.exit(1);
    });
}
