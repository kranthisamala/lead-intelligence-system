/**
 * Everything LLM-related: the prompt text and response schema, the HTTP
 * transport (retries, backoff, rate limits), and batching leads through it
 * with a template fallback when the API is unavailable.
 */
import { z } from 'zod';
import { AppConfig } from './config';
import { Logger } from './report';
import { REASON_LABELS } from './rubric';
import { EnrichedLead, OutreachMessage, ScoredLead } from './types';

// =============================================================================
// Prompt building + response schema
// =============================================================================

/** The company we are writing as. Change this block to re-brand the tool. */
export const BRAND = {
  company: 'Northbeam Analytics',
  product: 'a mid-market workflow analytics platform',
  value: 'shows operations and revenue teams where work actually stalls, across the tools they already use',
  proof: 'teams typically cut hand-offs and manual status chasing by 20-30% in the first quarter',
  senderRole: 'sales development rep',
};

export const SYSTEM_PROMPT = `You are a ${BRAND.senderRole} at ${BRAND.company}, which sells ${BRAND.product} that ${BRAND.value}. Typical proof point: ${BRAND.proof}.

You receive a batch of leads that a deterministic rules engine has ALREADY scored and decided on. Your job is writing, not judging.

For EVERY lead, return:
- "reasoning": 1-2 sentences explaining the decision in business terms. Cite the lead's actual company name, industry, employee count, source and how recent the interaction was. Reference the factors that drove the score. Never restate the raw numbers as a list.

Additionally:
- If decision is "qualified": return "messages" — an array of exactly 2 outreach openers, each an object {"variant": string, "text": string}. Variant 1 uses variant name "problem-led" and opens on a specific operational pain that a company of that size in that industry plausibly has. Variant 2 uses variant name "peer-proof" and leads with our proof point, quoted using ONLY the range given above (20-30%) — NEVER invent a specific comparable company, a different percentage, an employee count for that comparable, or any other detail about a past customer that was not given to you. Each message must be 2-3 sentences, under 65 words, and MUST name the company and either their industry or their employee count explicitly. End each with a low-friction question. No subject lines, no "Hope this finds you well", no placeholder brackets, no em dashes.
- If decision is "review": return "borderline_note" — one sentence naming the single thing a human should check before deciding. Do not return messages.
- If decision is "rejected" or "insufficient_data": return reasoning only. Do not return messages.

Rules:
- NEVER contradict or second-guess the given decision. Explain it as correct.
- If a field reads "(unknown company)", "(unknown contact)" or "(not recorded)", NEVER write those strings out. Work around the gap: address the person by first name, or open on their industry and size instead of the company name. A message must never expose a data gap to the recipient.
- NEVER invent facts about the company beyond what is supplied (no funding rounds, no headcount growth, no tool names they use).
- Write like a person, not a brochure. Plain, concrete, specific.
- Respond with a single JSON object and nothing else.`;

/** Compact, LLM-friendly view of a lead. Only fields the model should see. */
function serializeLead(lead: ScoredLead, referenceDateIso: string) {
  return {
    id: lead.id,
    name: lead.name ?? '(unknown contact)',
    company: lead.company ?? '(unknown company)',
    industry: lead.industry ?? '(not recorded)',
    employees: lead.companySize ?? '(not recorded)',
    source: lead.source ?? '(not recorded)',
    last_interaction: lead.lastInteractionRaw ?? '(not recorded)',
    days_since_interaction: lead.lastInteractionDate
      ? Math.floor(
          (new Date(referenceDateIso).getTime() - lead.lastInteractionDate.getTime()) / 86_400_000,
        )
      : null,
    factor_scores_out_of_10: lead.scores,
    composite_score: lead.compositeScore,
    decision: lead.decision,
    weakest_factor: lead.primaryRejectionReason
      ? (REASON_LABELS[lead.primaryRejectionReason] ?? lead.primaryRejectionReason)
      : null,
    rules_engine_notes: lead.decisionNotes,
    data_gaps: lead.edgeCaseFlags,
  };
}

export function buildBatchPrompt(leads: ScoredLead[], referenceDateIso: string): string {
  const payload = leads.map((l) => serializeLead(l, referenceDateIso));

  return `Today's reference date is ${referenceDateIso}. Here are ${leads.length} leads to write up:

${JSON.stringify(payload, null, 2)}

Return exactly this JSON shape, with one entry per lead above, in the same order, using the same "id" values:

{
  "results": [
    {
      "id": "Lead_001",
      "reasoning": "string",
      "messages": [ { "variant": "problem-led", "text": "string" }, { "variant": "peer-proof", "text": "string" } ],
      "borderline_note": "string"
    }
  ]
}

Include "messages" ONLY for decision "qualified". Include "borderline_note" ONLY for decision "review". Output the JSON object and nothing else.`;
}

/** Appended on a retry after a schema violation, rather than resending blind. */
export const REPAIR_INSTRUCTION =
  'Your previous response was not valid JSON matching the required schema. ' +
  'Return ONLY a single JSON object of the form {"results":[{"id":"...","reasoning":"..."}]} ' +
  'with one entry per lead. No markdown fences, no commentary.';

export const BatchResponseSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string(),
        reasoning: z.string().min(1),
        messages: z
          .array(z.object({ variant: z.string(), text: z.string().min(1) }))
          .optional(),
        borderline_note: z.string().optional(),
      }),
    )
    .min(1),
});

export type BatchResponse = z.infer<typeof BatchResponseSchema>;

/**
 * Models occasionally wrap JSON in markdown fences or add a preamble even when
 * asked not to. Salvaging that is cheaper than burning a retry on it.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('response contained no parseable JSON object');
  }
}

// =============================================================================
// Transport: HTTP calls, retries, backoff, rate limits
// =============================================================================

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 429/408/5xx are retryable. A 400 is normally permanent, except Groq's
 * `json_validate_failed` — a one-off bad generation, not a broken request.
 */
function isRetryableStatus(status: number, body?: string): boolean {
  if (status === 429 || status === 408 || status >= 500) return true;
  if (status === 400 && body && /json_validate_failed/i.test(body)) return true;
  return false;
}

export class LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  /** Flipped on after a rate limit so subsequent calls use the cheaper model. */
  private useFallbackModel = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly log: Logger,
  ) {
    const key = process.env[cfg.llm.api_key_env];
    if (!key) {
      throw new LlmError(
        `Missing API key: set ${cfg.llm.api_key_env} in your .env file ` +
          `(or run with --dry-run to skip the LLM entirely).`,
        undefined,
        false,
      );
    }
    this.apiKey = key;

    // Model names live only in .env (PROD_MODEL) — main.ts already checks
    // this before constructing an LlmClient, but enforce it here too so this
    // class can never be used with an unresolved model.
    if (!cfg.llm.model) {
      throw new LlmError('PROD_MODEL is not set in .env.', undefined, false);
    }
    this.model = cfg.llm.model;
  }

  /** True when a key is present, so main.ts can degrade gracefully instead of throwing. */
  static hasKey(cfg: AppConfig): boolean {
    return Boolean(process.env[cfg.llm.api_key_env]);
  }

  get activeModel(): string {
    return this.useFallbackModel && this.cfg.llm.fallback_model ? this.cfg.llm.fallback_model : this.model;
  }

  /** Sends one chat request, retrying with backoff. Returns the raw reply text. */
  async chat(messages: ChatMessage[], label: string): Promise<string> {
    const { max_attempts } = this.cfg.llm;
    let lastError: unknown;

    for (let attempt = 1; attempt <= max_attempts; attempt++) {
      try {
        const text = await this.callOnce(messages);
        if (attempt > 1) this.log.info(`${label}: succeeded on attempt ${attempt}`);
        return text;
      } catch (err) {
        lastError = err;
        const isLast = attempt === max_attempts;
        const status = err instanceof LlmError ? err.status : undefined;
        const retryable = err instanceof LlmError ? err.retryable : true;

        this.log.warn(
          `${label}: attempt ${attempt}/${max_attempts} failed` +
            (status ? ` (HTTP ${status})` : '') +
            `: ${(err as Error).message}`,
        );

        if (!retryable || isLast) break;

        // Rate limited — drop to the smaller/faster model for the rest of the run.
        if (status === 429 && this.cfg.llm.fallback_model && !this.useFallbackModel) {
          this.useFallbackModel = true;
          this.log.warn(
            `Rate limited — switching to fallback model "${this.cfg.llm.fallback_model}" for the rest of this run.`,
          );
        }

        const retryAfterMs = err instanceof LlmError ? this.retryAfterMs(err) : undefined;
        const backoff = retryAfterMs ?? this.backoffMs(attempt);
        this.log.info(`${label}: backing off ${backoff}ms`);
        await sleep(backoff);
      }
    }

    throw lastError instanceof Error ? lastError : new LlmError(String(lastError));
  }

  /** 1s, 2s, 4s, 8s ... plus jitter. */
  private backoffMs(attempt: number): number {
    return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
  }

  /** Respects a `Retry-After` header (seconds) if the error carries one. */
  private retryAfterMs(err: LlmError): number | undefined {
    const match = /retry-after[: ]+([0-9.]+)/i.exec(err.message);
    if (!match) return undefined;
    const seconds = Number.parseFloat(match[1]);
    return Number.isFinite(seconds) ? Math.min(seconds * 1000 + 250, 30_000) : undefined;
  }

  private async callOnce(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.llm.timeout_ms);

    try {
      return this.cfg.llm.provider === 'gemini'
        ? await this.callGemini(messages, controller.signal)
        : await this.callOpenAiCompatible(messages, controller.signal);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new LlmError(`request timed out after ${this.cfg.llm.timeout_ms}ms`, 408);
      }
      if (err instanceof LlmError) throw err;
      throw new LlmError(`network error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Groq, OpenAI, and anything else exposing a /chat/completions endpoint. */
  private async callOpenAiCompatible(
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<string> {
    const res = await fetch(`${this.cfg.llm.base_url}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.activeModel,
        messages,
        temperature: this.cfg.llm.temperature,
        max_tokens: this.cfg.llm.max_tokens,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      const retryAfter = res.headers.get('retry-after');
      throw new LlmError(
        `${res.status} ${res.statusText}` +
          (retryAfter ? ` retry-after: ${retryAfter}` : '') +
          ` — ${body.slice(0, 400)}`,
        res.status,
        isRetryableStatus(res.status, body),
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new LlmError('response contained no message content', undefined, true);
    return content;
  }

  private async callGemini(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    // Gemini has no `system` role — it takes a separate systemInstruction block.
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const url = `${this.cfg.llm.base_url}/models/${this.activeModel}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: {
          temperature: this.cfg.llm.temperature,
          maxOutputTokens: this.cfg.llm.max_tokens,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable body>');
      throw new LlmError(
        `${res.status} ${res.statusText} — ${body.slice(0, 400)}`,
        res.status,
        isRetryableStatus(res.status),
      );
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const content = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
    if (!content) throw new LlmError('response contained no candidate text', undefined, true);
    return content;
  }
}

// =============================================================================
// Batching leads through the LLM, with a template fallback
// =============================================================================

export interface EnrichmentStats {
  batchesAttempted: number;
  batchesFailed: number;
  templateFallbacks: number;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- Deterministic fallbacks ------------------------------------------------
// What the report contains when the LLM is unavailable. Decent enough to send
// after a quick human read.

function describeRecency(lead: ScoredLead): string {
  if (!lead.lastInteractionRaw) return 'with no recorded interaction date';
  return `last engaged ${lead.lastInteractionRaw}`;
}

export function templateReasoning(lead: ScoredLead): string {
  const who = lead.company ?? lead.name ?? lead.id;
  const size = lead.companySize !== undefined ? `${lead.companySize} employees` : 'unknown headcount';
  const industry = lead.industry ?? 'unrecorded industry';
  const source = lead.source ?? 'an unrecorded source';
  const weak = lead.primaryRejectionReason
    ? (REASON_LABELS[lead.primaryRejectionReason] ?? lead.primaryRejectionReason)
    : null;

  const base =
    `${who} (${industry}, ${size}) came in via ${source}, ${describeRecency(lead)}. ` +
    `Composite fit score ${lead.compositeScore}/10 against the rubric places it in "${lead.decision}"`;

  const tail = weak ? `, with the weakest factor being: ${weak.toLowerCase()}.` : '.';
  const notes = lead.decisionNotes.length > 0 ? ` ${lead.decisionNotes.join(' ')}` : '';
  return base + tail + notes;
}

export function templateMessages(lead: ScoredLead): OutreachMessage[] {
  const company = lead.company ?? 'your team';
  const industry = lead.industry ?? 'your sector';
  const sizeClause =
    lead.companySize !== undefined ? `a ${lead.companySize}-person ${industry} team` : `a ${industry} team`;
  const first = lead.name?.split(' ')[0] ?? 'there';

  return [
    {
      variant: 'problem-led',
      text:
        `Hi ${first}, at ${sizeClause} like ${company}, work usually stalls in the hand-offs between tools rather than inside any one of them. ` +
        `${BRAND.company} ${BRAND.value}. Worth 15 minutes to see whether that matches what you're seeing?`,
    },
    {
      variant: 'peer-proof',
      text:
        `Hi ${first}, we work with ${industry} teams around ${company}'s size, and ${BRAND.proof}. ` +
        `Given you came to us through ${lead.source ?? 'our site'}, I'd guess something specific prompted it. Open to a short call this week?`,
    },
  ];
}

export function templateBorderlineNote(lead: ScoredLead): string {
  if (lead.decisionNotes.length > 0) return lead.decisionNotes[0];
  const weak = lead.primaryRejectionReason
    ? (REASON_LABELS[lead.primaryRejectionReason] ?? lead.primaryRejectionReason)
    : 'overall fit';
  return `Scores mid-range at ${lead.compositeScore}/10; check "${weak.toLowerCase()}" before committing outreach time.`;
}

/** Builds a fully-populated lead with no model involvement. */
export function enrichFromTemplate(lead: ScoredLead): EnrichedLead {
  return {
    ...lead,
    reasoning: templateReasoning(lead),
    borderlineNote: lead.decision === 'review' ? templateBorderlineNote(lead) : undefined,
    outreachMessages: lead.decision === 'qualified' ? templateMessages(lead) : [],
    commentarySource: 'template',
  };
}

/** Marks a response the model returned but that failed our schema check. */
class SchemaError extends Error {}

/**
 * One batch: call, validate, retry once with a repair instruction if the
 * model's JSON didn't match the schema. Transport errors (already retried by
 * LlmClient) propagate straight out instead of triggering a repair retry.
 */
async function runBatch(
  batch: ScoredLead[],
  client: LlmClient,
  log: Logger,
  referenceDateIso: string,
  label: string,
): Promise<BatchResponse> {
  const userPrompt = buildBatchPrompt(batch, referenceDateIso);

  const attemptOnce = async (extra?: string): Promise<BatchResponse> => {
    const raw = await client.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: extra ? `${userPrompt}\n\n${extra}` : userPrompt },
      ],
      label,
    );
    const parsed = BatchResponseSchema.safeParse(extractJson(raw));
    if (!parsed.success) {
      throw new SchemaError(
        `schema validation failed: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
      );
    }
    return parsed.data;
  };

  try {
    return await attemptOnce();
  } catch (err) {
    // `extractJson` throws a plain Error on unparseable text; both cases are
    // "the model wrote something wrong" and are worth one corrective attempt.
    if (err instanceof LlmError) throw err;
    log.warn(`${label}: ${(err as Error).message}. Retrying once with a repair instruction.`);
    return attemptOnce(REPAIR_INSTRUCTION);
  }
}

/**
 * Merges a validated model response onto the scored leads of that batch.
 * Any lead the model skipped or returned unusable content for silently falls
 * back to its template — a partial batch never blocks the run.
 */
function mergeBatch(batch: ScoredLead[], response: BatchResponse, log: Logger): EnrichedLead[] {
  const byId = new Map(response.results.map((r) => [r.id, r]));

  return batch.map((lead) => {
    const result = byId.get(lead.id);
    if (!result) {
      log.warn(`${lead.id}: model returned no entry for this lead; using template fallback.`);
      return enrichFromTemplate(lead);
    }

    const messages =
      lead.decision === 'qualified'
        ? (result.messages ?? []).filter((m) => m.text.trim().length > 0)
        : [];

    // A qualified lead with no usable message is worse than a templated one.
    if (lead.decision === 'qualified' && messages.length === 0) {
      log.warn(`${lead.id}: qualified but model returned no message; using template messages.`);
      return { ...enrichFromTemplate(lead), reasoning: result.reasoning, commentarySource: 'template' };
    }

    return {
      ...lead,
      reasoning: result.reasoning.trim(),
      borderlineNote:
        lead.decision === 'review'
          ? (result.borderline_note?.trim() ?? templateBorderlineNote(lead))
          : undefined,
      outreachMessages: messages,
      commentarySource: 'llm',
    };
  });
}

export async function enrichLeads(
  leads: ScoredLead[],
  client: LlmClient | null,
  cfg: AppConfig,
  log: Logger,
  referenceDateIso: string,
): Promise<{ leads: EnrichedLead[]; stats: EnrichmentStats }> {
  const stats: EnrichmentStats = { batchesAttempted: 0, batchesFailed: 0, templateFallbacks: 0 };

  if (!client) {
    log.info(`LLM disabled — generating reasoning and outreach from templates for ${leads.length} leads.`);
    const enriched = leads.map(enrichFromTemplate);
    stats.templateFallbacks = enriched.length;
    return { leads: enriched, stats };
  }

  const batches = chunk(leads, cfg.llm.batch_size);
  log.info(
    `Enriching ${leads.length} leads in ${batches.length} batch(es) of up to ${cfg.llm.batch_size} ` +
      `(model: ${client.activeModel}).`,
  );

  const out: EnrichedLead[] = [];
  /** Set on a permanent error (bad key, unknown model): stop calling entirely. */
  let abandonLlm = false;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const label = `batch ${i + 1}/${batches.length}`;

    if (abandonLlm) {
      stats.templateFallbacks += batch.length;
      out.push(...batch.map(enrichFromTemplate));
      continue;
    }

    stats.batchesAttempted++;

    try {
      const response = await runBatch(batch, client, log, referenceDateIso, label);
      const merged = mergeBatch(batch, response, log);
      stats.templateFallbacks += merged.filter((l) => l.commentarySource === 'template').length;
      out.push(...merged);
      log.info(`${label}: ok (${batch.length} leads).`);
    } catch (err) {
      // The batch is lost, the run is not.
      stats.batchesFailed++;
      stats.templateFallbacks += batch.length;
      log.error(
        `${label}: giving up (${(err as Error).message}). Using template fallback for ${batch.length} leads.`,
      );
      out.push(...batch.map(enrichFromTemplate));

      // A non-retryable failure (401/403/404 — bad key, no access, wrong model)
      // will fail identically for every remaining batch. Retrying it 9 more
      // times wastes minutes and quota to arrive at the same templates, so stop
      // calling and finish the run offline. Alert loudly: this needs a human.
      if (err instanceof LlmError && !err.retryable) {
        abandonLlm = true;
        log.error(
          `Permanent LLM failure (HTTP ${err.status ?? '?'}). Abandoning API calls for the rest of ` +
            `this run — the remaining ${leads.length - out.length} lead(s) will use template prose. ` +
            `Check ${cfg.llm.api_key_env} and llm.model in config.yaml.`,
        );
      }
    }

    // Pace the calls so a 100+ lead run does not trip the free-tier rate limit.
    if (i < batches.length - 1 && !abandonLlm && cfg.llm.delay_between_batches_ms > 0) {
      await sleep(cfg.llm.delay_between_batches_ms);
    }
  }

  return { leads: out, stats };
}
