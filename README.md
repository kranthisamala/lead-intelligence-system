# Lead Intelligence System

A CLI tool that scores inbound leads against a rubric, sorts them into a
priority queue, and writes personalized outreach with an LLM. Built for the
brief's scenario: a company getting ~1,200 leads a month, manually triaging
each one in 8-12 minutes.

## How to run it

```bash
npm install
cp .env.example .env          # paste your GROQ_API_KEY in here
npm start                     # full run on data/leads.csv
```

A couple other useful commands:

```bash
npm run dry                              # rules engine only, no LLM, no cost — instant
npx ts-node src/main.ts --limit 5        # test the prompt on a handful of leads before the full batch
```

`npm start` is pinned to Groq by default; pass `--provider openai` or
`--provider gemini` (with the matching key in `.env`) to use a different one.
Output lands in `output/` — `output_report.json`, `priority_queue.csv` (a flat
list an SDR can open in Excel), and `run.log`.

## The rubric

Each lead is scored 1-10 on five weighted factors — company size (30%),
source quality (25%), industry fit (20%), recency (15%), and data
completeness (10%) — combined into one composite score. A composite of 8.0+
qualifies, 7.0-7.9 gets flagged for a human to review, and below 7.0 is
rejected; a record with two or fewer fields filled in goes straight to
"insufficient data" regardless of score. All the weights and thresholds live
in `config.yaml`, not hardcoded, so they're easy to see and argue with. The
LLM never makes the qualify/reject call — that's 100% rule-based — it only
writes the reasoning sentence and the outreach message.

## Three things that broke, and what I changed

- **First rubric pass was too soft** (tier-B industry = 7, 10-49 employees = 7). Ran it over the sample leads and got 59% qualified, 1 rejection — not useful. Made the scoring bands harsher (a 10 now means genuinely textbook-fit) and re-ran: 26.7% qualified / 36.7% review / 36.7% rejected, a distribution that actually looks like triage.
- **The planned model didn't exist anymore.** The original plan called for `llama-3.3-70b-versatile` on Groq; by the time I had a key, Groq had dropped it from their catalog (live 404). Checked `GET /v1/models` and switched to `openai/gpt-oss-120b` / `-20b`.
- **A live run exposed a real rate limit.** My Groq account caps at 8,000 tokens/minute, and a 10-lead batch alone requested ~6,600 — batches kept colliding with the limit and some fell back to templates. Read it in `run.log`, dropped batch size from 10 to 5, fixed it.

## Known limitations

- **Recency is scored against the data, not today's date.** The sample leads are from around Jan 2024; scoring "days since last contact" against the real clock would make every lead look ancient. `reference_date: auto` in the config anchors to the newest date in the file instead — pin a real date for production use.
- **Industry tiers are a list I made up** based on a guess at the fictional product's ICP. Anything not on the list scores neutral rather than getting penalized.
- **Company size is a rough stand-in for budget.** A 40-person law firm and a 40-person SaaS startup are very different buyers at the same headcount, but that's all the CSV gives me to work with.
- **The outreach messages should get a human skim before sending.** The prompt only uses facts present in the CSV and forbids inventing customer stats, but tone isn't guaranteed to land perfectly every time.
- **This ships with 30 real leads, not 100+.** The brief mentions 100+; I chose not to pad the numbers with leads I generated myself, since that would make the qualified/review/rejected split describe a random number generator instead of something real. The rubric and pipeline were tested at 100+ leads during development with no crashes.
- **None of the weights are validated against real conversion data** — they're a reasonable guess at what a good lead looks like, not a fitted model.
