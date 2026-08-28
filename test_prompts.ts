/**
 * Prompt test harness — try the prompt on a handful of leads before a full
 * batch run. Uses Groq's small model by default (cheap, fast); pass --model
 * to test a different one. Picks leads across all four decision buckets, not
 * just the first N rows, and runs automated checks on the generated copy.
 *
 *   npm run test:prompts
 *   npm run test:prompts -- --count 10
 *   npm run test:prompts -- --provider openai --model gpt-4o
 */
import 'dotenv/config';
import { loadCsvs, normalizeAll, resolveReferenceDate, toIsoDate } from './src/dataLoader';
import { loadConfig } from './src/config';
import { enrichLeads, LlmClient } from './src/llm';
import { applyProviderPreset, Provider } from './src/main';
import { Logger } from './src/report';
import { assignPriority, scoreLead } from './src/rubric';
import { Decision, EnrichedLead, ScoredLead } from './src/types';

const argv = process.argv.slice(2);
const countArg = argv.indexOf('--count');
const SAMPLE_SIZE = countArg !== -1 ? Number.parseInt(argv[countArg + 1], 10) : 6;
const providerArg = argv.indexOf('--provider');
const PROVIDER = providerArg !== -1 ? (argv[providerArg + 1] as Provider) : undefined;
const modelArg = argv.indexOf('--model');
// --model wins if passed; otherwise TEST_MODEL from .env, so which model this
// script tests against is a config change, not a code/script change.
const MODEL = modelArg !== -1 ? argv[modelArg + 1] : process.env.TEST_MODEL;

/** Takes leads from each decision bucket so every prompt branch gets exercised. */
function pickAcrossBuckets(leads: ScoredLead[], total: number): ScoredLead[] {
  const buckets: Decision[] = ['qualified', 'review', 'rejected', 'insufficient_data'];
  const picked: ScoredLead[] = [];
  let i = 0;
  while (picked.length < total) {
    const bucket = buckets[i % buckets.length];
    const candidate = leads.find((l) => l.decision === bucket && !picked.includes(l));
    if (candidate) picked.push(candidate);
    i++;
    if (i > buckets.length * total) break; // some buckets may be empty
  }
  return picked;
}

// --- Quality checks on generated copy ---------------------------------------
interface Check {
  name: string;
  test: (lead: EnrichedLead) => boolean | 'n/a';
}

const CHECKS: Check[] = [
  {
    name: 'reasoning is present and specific',
    test: (l) => l.reasoning.length > 40,
  },
  {
    name: 'qualified leads got 2 message variants',
    test: (l) => (l.decision === 'qualified' ? l.outreachMessages.length >= 2 : 'n/a'),
  },
  {
    name: 'message names the company',
    test: (l) =>
      l.decision === 'qualified' && l.company
        ? l.outreachMessages.every((m) => m.text.toLowerCase().includes(l.company!.toLowerCase()))
        : 'n/a',
  },
  {
    name: 'message is 2-3 sentences, under 80 words',
    test: (l) =>
      l.decision === 'qualified'
        ? l.outreachMessages.every((m) => m.text.split(/\s+/).length <= 80)
        : 'n/a',
  },
  {
    name: 'no unfilled placeholders',
    test: (l) =>
      l.outreachMessages.every((m) => !/\[[^\]]+\]|\{\{?[^}]+\}?\}/.test(m.text)) &&
      !/\[[^\]]+\]/.test(l.reasoning),
  },
  {
    name: 'no subject line leaked in',
    test: (l) => l.outreachMessages.every((m) => !/^subject\s*:/i.test(m.text.trim())),
  },
  {
    // A model asked for "peer-proof" will happily invent a specific comparable
    // customer (a headcount, a different percentage) that does not exist. That
    // reads as a fabricated case study a prospect could ask to verify, so any
    // digit pattern beyond our own given range (20-30%, 15 minutes) fails this.
    name: 'no fabricated comparable-customer specifics',
    test: (l) => {
      if (l.commentarySource !== 'llm' || l.decision !== 'qualified') return 'n/a';
      // Models render the range with typographic dashes (‑ U+2011, – U+2013,
      // — U+2014), not always a plain ASCII "-", so match any of them.
      let allowed = '20[-\\u2010\\u2011\\u2013\\u2014]30\\s?%|20 to 30 ?%|15 minutes';
      // The lead's own real headcount is legitimate to restate ("a 200-person retailer").
      if (l.companySize !== undefined) allowed += `|\\b${l.companySize}\\b`;
      const allowedRe = new RegExp(allowed, 'gi');
      return l.outreachMessages.every((m) => {
        const stripped = m.text.replace(allowedRe, '');
        // Flags any other number attached to a %, "employee(s)" or "person/people"
        // — that pattern is how models fabricate a specific comparable customer.
        return !/\b\d{1,3}([,.]\d+)?\s?%|\b\d{2,6}[- ]?(person|employee)/i.test(stripped);
      });
    },
  },
  {
    name: 'review leads got a borderline note',
    test: (l) => (l.decision === 'review' ? Boolean(l.borderlineNote?.trim()) : 'n/a'),
  },
  {
    name: 'variants are actually different',
    test: (l) =>
      l.decision === 'qualified' && l.outreachMessages.length >= 2
        ? l.outreachMessages[0].text !== l.outreachMessages[1].text
        : 'n/a',
  },
];

async function main() {
  const cfg = loadConfig();
  if (PROVIDER) applyProviderPreset(cfg, PROVIDER, MODEL);
  else if (MODEL) cfg.llm.model = MODEL;
  const log = new Logger('output/run.log');
  const { rows, file } = loadCsvs(['data/leads.csv']);
  const leads = normalizeAll(rows);
  const referenceDate = resolveReferenceDate(leads, cfg.reference_date);
  const scored = assignPriority(leads.map((l) => scoreLead(l, referenceDate, cfg)), cfg);

  const sample = pickAcrossBuckets(scored, SAMPLE_SIZE);
  const line = '─'.repeat(70);

  console.log(`\n${line}`);
  console.log(`  PROMPT TEST — ${sample.length} leads from ${file}`);
  console.log(`  ${LlmClient.hasKey(cfg) ? `Live call to ${cfg.llm.provider}/${cfg.llm.model}` : 'NO API KEY — testing the template fallback path instead'}`);
  console.log(line);

  const client = LlmClient.hasKey(cfg) ? new LlmClient(cfg, log) : null;
  const { leads: enriched } = await enrichLeads(sample, client, cfg, log, toIsoDate(referenceDate));

  for (const l of enriched) {
    console.log(`\n${line}`);
    console.log(`  ${l.id}  ${l.name ?? '(no name)'} — ${l.company ?? '(no company)'}`);
    console.log(`  ${l.industry ?? '?'} | ${l.companySize ?? '?'} employees | ${l.source ?? '?'} | ${l.lastInteractionRaw ?? 'no date'}`);
    console.log(`  scores: ${JSON.stringify(l.scores)}`);
    console.log(`  composite ${l.compositeScore}/10  ->  ${l.decision.toUpperCase()}  [${l.commentarySource}]`);
    console.log(`\n  REASONING: ${l.reasoning}`);
    if (l.borderlineNote) console.log(`  BORDERLINE: ${l.borderlineNote}`);
    for (const m of l.outreachMessages) {
      console.log(`\n  MESSAGE (${m.variant}):\n    ${m.text}`);
    }
  }

  // --- Aggregate check results ---
  console.log(`\n${line}\n  QUALITY CHECKS\n${line}`);
  let failures = 0;
  for (const check of CHECKS) {
    const applicable = enriched.map((l) => check.test(l)).filter((r) => r !== 'n/a') as boolean[];
    if (applicable.length === 0) {
      console.log(`  --  ${check.name} (not applicable to this sample)`);
      continue;
    }
    const passed = applicable.filter(Boolean).length;
    const ok = passed === applicable.length;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${check.name}  (${passed}/${applicable.length})`);
  }

  console.log(line);
  console.log(
    failures === 0
      ? '  All checks passed. Safe to run the full batch.\n'
      : `  ${failures} check(s) failed — tighten src/prompts.ts before the full run.\n`,
  );

  log.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Prompt test failed:', err);
  process.exit(1);
});
