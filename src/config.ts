/**
 * Loads config.yaml and checks it with zod before the rest of the pipeline
 * runs. Without this, a typo in one of the weights just quietly turns into
 * NaN scores three steps later and you're debugging the wrong file. Better
 * to fail loudly here with the exact field name than get a report full of nulls.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';

/** A scoring band: the first band whose `max` the value fits into wins. */
const BandSchema = z.object({
  max: z.number().nullable(),
  score: z.number().min(0).max(10),
});

const ConfigSchema = z.object({
  llm: z.object({
    provider: z.enum(['groq', 'openai', 'gemini']),
    model: z.string(),
    fallback_model: z.string().optional(),
    base_url: z.string().url(),
    api_key_env: z.string(),
    temperature: z.number().min(0).max(2),
    max_tokens: z.number().int().positive(),
    batch_size: z.number().int().positive(),
    delay_between_batches_ms: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
  }),
  reference_date: z.union([z.literal('auto'), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  weights: z.object({
    company_size: z.number(),
    industry_fit: z.number(),
    source_quality: z.number(),
    recency: z.number(),
    data_completeness: z.number(),
  }),
  company_size_bands: z.array(BandSchema).min(1),
  company_size_missing_score: z.number().min(0).max(10),
  industry_tiers: z.object({
    tier_a_score: z.number(),
    tier_a: z.array(z.string()),
    tier_b_score: z.number(),
    tier_b: z.array(z.string()),
    tier_c_score: z.number(),
    tier_c: z.array(z.string()),
    unknown_score: z.number(),
  }),
  source_scores: z.record(z.number()),
  recency_bands: z.array(BandSchema).min(1),
  recency_missing_score: z.number().min(0).max(10),
  decision_thresholds: z.object({
    qualified_min: z.number(),
    review_min: z.number(),
    insufficient_data_completeness_max: z.number(),
  }),
  hard_filters: z.object({
    min_company_size_for_qualified: z.number(),
    max_company_size_for_qualified: z.number(),
    require_known_company_size: z.boolean(),
  }),
  priority_tiers: z.array(z.object({ min: z.number(), tier: z.string() })).min(1),
  output: z.object({
    sample_message_count: z.number().int().positive(),
    write_priority_queue_csv: z.boolean(),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath = path.resolve(process.cwd(), 'config.yaml')): AppConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }

  const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const result = ConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`config.yaml failed validation:\n${issues}`);
  }

  const cfg = result.data;

  // Weights must sum to 1.0, otherwise the composite is not on a 1-10 scale and
  // the thresholds below it stop meaning what the README says they mean.
  const weightSum = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    throw new Error(`config.yaml: weights must sum to 1.0, got ${weightSum.toFixed(4)}`);
  }

  if (cfg.decision_thresholds.review_min >= cfg.decision_thresholds.qualified_min) {
    throw new Error('config.yaml: decision_thresholds.review_min must be below qualified_min');
  }

  if (cfg.source_scores.default === undefined) {
    throw new Error('config.yaml: source_scores must include a `default` entry');
  }

  return cfg;
}
