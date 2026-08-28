/**
 * CSV loading + normalization: reads raw rows from disk, then cleans each
 * one into a `Lead` with edge-case flags. Downstream code can assume a field
 * is either valid or `undefined`; every gap is flagged.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { Lead, RawRow } from './types';

// --- CSV loading -------------------------------------------------------

const REQUIRED_COLUMNS = [
  'name',
  'company',
  'company_size',
  'industry',
  'source',
  'last_interaction_date',
];

export interface LoadedFile {
  rows: RawRow[];
  file: string;
}

/**
 * Reads one CSV. Uses `relax_column_count` so a row with a trailing comma or a
 * short row does not abort the whole run — the brief's data is messy by design.
 */
export function loadCsv(filePath: string): LoadedFile {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Input file not found: ${abs}`);
  }

  const raw = fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''); // strip BOM if Excel wrote it

  const rows = parse(raw, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as RawRow[];

  if (rows.length === 0) {
    throw new Error(`Input file has no data rows: ${abs}`);
  }

  const present = Object.keys(rows[0]);
  const missing = REQUIRED_COLUMNS.filter((c) => !present.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `Input file ${path.basename(abs)} is missing expected column(s): ${missing.join(', ')}.\n` +
        `Found: ${present.join(', ')}`,
    );
  }

  return { rows, file: path.basename(abs) };
}

/** Loads several CSVs and concatenates them, tagging each row with its origin. */
export function loadCsvs(filePaths: string[]): LoadedFile {
  const all: RawRow[] = [];
  const names: string[] = [];
  for (const p of filePaths) {
    const { rows, file } = loadCsv(p);
    names.push(file);
    for (const r of rows) all.push({ ...r, __origin: file });
  }
  return { rows: all, file: names.join(' + ') };
}

// --- Normalization -------------------------------------------------------

/** Strings that mean "no value" in these exports. Compared case-insensitively. */
const NULL_TOKENS = new Set(['', 'na', 'n/a', 'null', 'none', 'unknown', '-', '--', 'nan']);

/** Source values that literally say "unknown" — kept, but scored as unmapped. */
const UNKNOWN_SOURCE_TOKENS = new Set(['unknown source', 'unknown', 'other']);

function clean(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return NULL_TOKENS.has(trimmed.toLowerCase()) ? undefined : trimmed;
}

/**
 * Parses `YYYY-MM-DD` (and anything else `Date` understands) into a UTC date.
 * Returns `undefined` for garbage rather than an `Invalid Date` that would
 * silently poison every arithmetic operation downstream.
 */
function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    const [, y, m, d] = iso;
    const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    // Guards against 2024-13-45 parsing into a rolled-over date.
    return dt.getUTCMonth() === Number(m) - 1 && dt.getUTCDate() === Number(d) ? dt : undefined;
  }
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? undefined : fallback;
}

export function normalizeLead(raw: RawRow, index: number): Lead {
  const flags: string[] = [];

  const name = clean(raw.name);
  const company = clean(raw.company);
  const industry = clean(raw.industry);

  // Source: keep an explicit "Unknown Source" value out of the scored set, but
  // record it distinctly from a genuinely blank cell — they mean different things.
  const rawSource = clean(raw.source);
  let source: string | undefined = rawSource;
  if (rawSource && UNKNOWN_SOURCE_TOKENS.has(rawSource.toLowerCase())) {
    source = undefined;
    flags.push('source_reported_as_unknown');
  }

  // Company size: must be a positive integer to be usable.
  let companySize: number | undefined;
  const rawSize = clean(raw.company_size);
  if (rawSize !== undefined) {
    const parsed = Number.parseInt(rawSize.replace(/[,\s]/g, ''), 10);
    if (Number.isNaN(parsed)) {
      flags.push('invalid_company_size');
    } else if (parsed <= 0) {
      flags.push('invalid_company_size');
    } else {
      companySize = parsed;
    }
  }

  // Date: unparseable is treated the same as absent, but flagged differently.
  const rawDate = clean(raw.last_interaction_date);
  const lastInteractionDate = parseDate(rawDate);
  if (rawDate !== undefined && lastInteractionDate === undefined) {
    flags.push('invalid_interaction_date');
  }

  if (name === undefined) flags.push('missing_name');
  if (company === undefined) flags.push('missing_company');
  if (companySize === undefined && !flags.includes('invalid_company_size')) {
    flags.push('missing_company_size');
  }
  if (industry === undefined) flags.push('missing_industry');
  if (source === undefined && !flags.includes('source_reported_as_unknown')) {
    flags.push('missing_source');
  }
  if (rawDate === undefined) flags.push('missing_interaction_date');

  // With neither a person nor a company there is nothing to reach out to.
  // This forces `insufficient_data` later regardless of how the rest scores.
  if (name === undefined && company === undefined) flags.push('no_identifier');

  return {
    id: `Lead_${String(index + 1).padStart(3, '0')}`,
    name,
    company,
    companySize,
    industry,
    source,
    lastInteractionDate,
    lastInteractionRaw: rawDate,
    edgeCaseFlags: flags,
    origin: raw.__origin,
  };
}

export function normalizeAll(rows: RawRow[]): Lead[] {
  return rows.map(normalizeLead);
}

/**
 * The recency anchor. The sample data ends in Jan 2024, so scoring against
 * `new Date()` would collapse every lead into the "stale" band and make the
 * factor carry no signal. Defaults to the newest date actually present.
 */
export function resolveReferenceDate(leads: Lead[], configured: string): Date {
  if (configured !== 'auto') {
    const pinned = parseDate(configured);
    if (!pinned) throw new Error(`config.yaml: reference_date "${configured}" is not a valid date`);
    return pinned;
  }

  const timestamps = leads
    .map((l) => l.lastInteractionDate?.getTime())
    .filter((t): t is number => t !== undefined);

  // No usable dates at all — fall back to today so the pipeline still runs.
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)) : new Date();
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
