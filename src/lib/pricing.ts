// Pure pricing engine — the single source of truth for token→USD conversion.
// Imported by the renderer (per-message footer) and by electron main-process
// services (session cost, usage dashboard, cost history). Must stay free of
// Node and DOM APIs so it type-checks under both tsconfigs.
//
// Rates: docs/superpowers/specs/2026-07-17-session-cost-tracking-design.md §1.

export interface ModelRates {
  /** USD per single token (per-MTok sticker price / 1e6). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** User-supplied rate override, in USD per MTok (matches published pricing).
 *
 * `from` is the date the override takes effect, inclusive. The flat legacy
 * shape (no `from`) normalises to `1970-01-01`, i.e. always applicable. */
export interface PricingOverride {
  from?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

/** A normalised override period — `from` is always present after parsing. */
export type PricingOverridePeriod = PricingOverride & { from: string };

/** Keyed by model-id substring pattern, e.g. `{ "opus-4-8": [{ from, input }] }`.
 *  Periods are sorted ascending by `from`. */
export type PricingOverrides = Record<string, PricingOverridePeriod[]>;

export interface UsageTokens {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  /** Which speed served the turn — `'fast'` bills at the fast-mode rate. */
  speed?: string | null;
}

export interface MessageCost {
  usd: number;
  /** True when the model matched no table entry and no override. */
  estimated: boolean;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
}

const MTOK = 1_000_000;

/** One rate period for one model. `from` is inclusive; a period runs until the
 *  next one starts, or forever if it is the last. */
export interface RatePeriod {
  from: string;
  inputPerM: number;
  outputPerM: number;
  fastInputPerM?: number;
  fastOutputPerM?: number;
}

// Ordered most-specific-first; first `model.includes(pattern)` match wins.
//
// RATES ARE EFFECTIVE-DATED. When a price changes, APPEND a period with the
// effective date — never edit a rate in place. Rates are flat only in the
// sense that every model currently has one period; editing that period
// re-prices all of history the next time a session is re-scanned, because
// `backfill()` recomputes `cost_usd` from tokens. Appending prices the days
// before the change at the old rate and the days after at the new one, which
// is the entire point.
//
// The bare `opus` row is a LEGACY catch-all priced for Opus 3. Every modern
// Opus needs its own row above it — `claude-opus-5` matched none of the
// `opus-4-x` patterns and fell through to 15/75, inflating its cost 3x.
//
// `fastInputPerM` / `fastOutputPerM` are set only on models that actually
// support fast mode (Opus 5 and Opus 4.8; 4.7's was removed upstream).
//
// `<synthetic>` is a CLI bookkeeping record that carries no usage. It is
// priced at zero EXPLICITLY rather than left unmatched, so that the
// unpriced-model warning stays meaningful — a flag that fires on every scan
// is a flag nobody reads.
export const RATE_TABLE: Array<{ pattern: string; periods: RatePeriod[] }> = [
  { pattern: '<synthetic>', periods: [{ from: '2024-01-01', inputPerM: 0, outputPerM: 0 }] },
  { pattern: 'fable', periods: [{ from: '2024-01-01', inputPerM: 10, outputPerM: 50 }] },
  { pattern: 'mythos', periods: [{ from: '2024-01-01', inputPerM: 10, outputPerM: 50 }] },
  { pattern: 'opus-5', periods: [{ from: '2024-01-01', inputPerM: 5, outputPerM: 25, fastInputPerM: 10, fastOutputPerM: 50 }] },
  { pattern: 'opus-4-8', periods: [{ from: '2024-01-01', inputPerM: 5, outputPerM: 25, fastInputPerM: 10, fastOutputPerM: 50 }] },
  { pattern: 'opus-4-7', periods: [{ from: '2024-01-01', inputPerM: 5, outputPerM: 25 }] },
  { pattern: 'opus-4-6', periods: [{ from: '2024-01-01', inputPerM: 5, outputPerM: 25 }] },
  { pattern: 'opus-4-5', periods: [{ from: '2024-01-01', inputPerM: 5, outputPerM: 25 }] },
  { pattern: 'opus', periods: [{ from: '2024-01-01', inputPerM: 15, outputPerM: 75 }] },
  { pattern: 'haiku-4-5', periods: [{ from: '2024-01-01', inputPerM: 1, outputPerM: 5 }] },
  { pattern: 'haiku', periods: [{ from: '2024-01-01', inputPerM: 0.25, outputPerM: 1.25 }] },
  { pattern: 'sonnet', periods: [{ from: '2024-01-01', inputPerM: 3, outputPerM: 15 }] },
];

/** Cache pricing as multipliers on the input rate, effective-dated for the
 *  same reason the rates themselves are. Output tokens are never cached. */
export interface CacheMultiplierPeriod {
  from: string;
  read: number;
  write5m: number;
  write1h: number;
}

export const CACHE_MULTIPLIERS: CacheMultiplierPeriod[] = [
  { from: '2024-01-01', read: 0.1, write5m: 1.25, write1h: 2 },
];

const DEFAULT_RATES = { inputPerM: 3, outputPerM: 15 }; // sonnet-tier fallback

/** ISO date (YYYY-MM-DD) for "now", in UTC — the same basis the daily cost
 *  rows are bucketed on. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The period that applies on `date`: the one with the latest `from` on or
 * before it.
 *
 * Order-independent — callers should not have to keep the list sorted. A date
 * before every period falls back to the earliest rather than reporting the
 * model unpriced: a transcript predating the table is far likelier than a
 * genuinely unknown model, and reporting it unpriced would understate cost.
 */
export function ratePeriodFor<T extends { from: string }>(
  periods: readonly T[],
  date: string,
): T | undefined {
  let best: T | undefined;
  let earliest: T | undefined;
  for (const p of periods) {
    if (!earliest || p.from < earliest.from) earliest = p;
    if (p.from <= date && (!best || p.from > best.from)) best = p;
  }
  return best ?? earliest;
}

function baseRates(inputPerM: number, outputPerM: number, date: string): ModelRates {
  const input = inputPerM / MTOK;
  // ratePeriodFor never returns undefined for a non-empty list, and
  // CACHE_MULTIPLIERS is a module constant with at least one entry.
  const mult = ratePeriodFor(CACHE_MULTIPLIERS, date)!;
  return {
    input,
    output: outputPerM / MTOK,
    cacheRead: input * mult.read,
    cacheWrite5m: input * mult.write5m,
    cacheWrite1h: input * mult.write1h,
  };
}

export function resolveRates(
  model: string,
  overrides?: PricingOverrides,
  opts?: {
    /**
     * `usage.speed` from the turn. `'fast'` selects the fast-mode rate on
     * models that have one; anything else (including a model with no fast
     * rate) uses the standard rate rather than inventing a premium.
     */
    speed?: string | null;
    /**
     * The day the tokens were billed, `YYYY-MM-DD`, used to pick the rate
     * period. Defaults to today, which is right for live-turn callers (the
     * per-message footer) and wrong for historical ones — `computeSessionCost`
     * passes each row's own date.
     */
    date?: string;
  },
): { rates: ModelRates; estimated: boolean } {
  const m = (model || '').toLowerCase();
  const date = opts?.date ?? today();
  const entry = RATE_TABLE.find((e) => m.includes(e.pattern));
  const period = entry ? ratePeriodFor(entry.periods, date) : undefined;

  const fast = opts?.speed === 'fast';
  const inputPerM = (fast ? period?.fastInputPerM : undefined) ?? period?.inputPerM;
  const outputPerM = (fast ? period?.fastOutputPerM : undefined) ?? period?.outputPerM;

  let rates =
    inputPerM != null && outputPerM != null
      ? baseRates(inputPerM, outputPerM, date)
      : baseRates(DEFAULT_RATES.inputPerM, DEFAULT_RATES.outputPerM, date);
  let estimated = !period;

  if (overrides) {
    const key = Object.keys(overrides)
      .sort((a, b) => b.length - a.length)
      .find((k) => k.length > 0 && m.includes(k.toLowerCase()));
    // An override key can match while none of its periods has started yet —
    // a scheduled price change entered ahead of time. That is not an override
    // for this date, so the table rate stands.
    const o = key ? overridePeriodFor(overrides[key], date) : undefined;
    if (o) {
      const mult = ratePeriodFor(CACHE_MULTIPLIERS, date)!;
      const input = o.input != null ? o.input / MTOK : rates.input;
      rates = {
        input,
        output: o.output != null ? o.output / MTOK : rates.output,
        cacheRead: o.cacheRead != null ? o.cacheRead / MTOK : input * mult.read,
        cacheWrite5m: o.cacheWrite5m != null ? o.cacheWrite5m / MTOK : input * mult.write5m,
        cacheWrite1h: o.cacheWrite1h != null ? o.cacheWrite1h / MTOK : input * mult.write1h,
      };
      estimated = false;
    }
  }
  return { rates, estimated };
}

/** The override period in force on `date`, or undefined if none has started.
 *  Unlike `ratePeriodFor` there is no fall-back to the earliest period: an
 *  override is a deliberate statement about a date range, so a date before it
 *  begins must fall through to the table rate. */
function overridePeriodFor(
  periods: readonly PricingOverridePeriod[],
  date: string,
): PricingOverridePeriod | undefined {
  let best: PricingOverridePeriod | undefined;
  for (const p of periods) {
    if (p.from <= date && (!best || p.from > best.from)) best = p;
  }
  return best;
}

export function splitCacheWriteTokens(usage: UsageTokens): { t5m: number; t1h: number } {
  const split = usage.cache_creation;
  if (split && (split.ephemeral_5m_input_tokens != null || split.ephemeral_1h_input_tokens != null)) {
    return { t5m: split.ephemeral_5m_input_tokens ?? 0, t1h: split.ephemeral_1h_input_tokens ?? 0 };
  }
  return { t5m: usage.cache_creation_input_tokens ?? 0, t1h: 0 };
}

/**
 * Every input token a turn consumed, across the three fields the API splits
 * them over.
 *
 * `input_tokens` on its own is NOT "the input" — with prompt caching it counts
 * only the uncached remainder, and Claude Code caches on every request. On a
 * live transcript it was 2 in 293 of 296 assistant messages while the real
 * input ran to tens of thousands, so anything rendering that field alone
 * understates by orders of magnitude.
 *
 * Output is deliberately excluded; `turnContextTotal` in `turnDelta.ts` is the
 * one that adds it, because it answers a different question (how big the
 * context got, not what this turn read).
 */
export function totalInputTokens(usage: UsageTokens): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

export function computeMessageCost(
  model: string,
  usage: UsageTokens,
  overrides?: PricingOverrides,
  /** Billing day, `YYYY-MM-DD`; defaults to today. Historical callers must
   *  pass the row's own date or a rate change re-prices the past. */
  date?: string,
): MessageCost {
  // An explicit user override wins over the fast-mode rate — it is a
  // deliberate statement about what a token costs, so fast mode must not
  // silently double it. resolveRates applies overrides last.
  const { rates, estimated } = resolveRates(model, overrides, { speed: usage.speed, date });
  const inputUsd = (usage.input_tokens ?? 0) * rates.input;
  const outputUsd = (usage.output_tokens ?? 0) * rates.output;
  const cacheReadUsd = (usage.cache_read_input_tokens ?? 0) * rates.cacheRead;
  const { t5m, t1h } = splitCacheWriteTokens(usage);
  const cacheWriteUsd = t5m * rates.cacheWrite5m + t1h * rates.cacheWrite1h;
  return {
    usd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
    estimated,
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
  };
}

const KNOWN_OVERRIDE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Flat overrides predate effective dating; treat them as always applicable
 *  so an existing `pricing_overrides` setting keeps working untouched. */
const LEGACY_FROM = '1970-01-01';

/** One period, validated down to the five known numeric fields. Returns
 *  undefined when nothing usable survives — a period that sets no rate is
 *  noise, and a bad `from` is worse than none because it would silently
 *  apply from the wrong day. */
function parsePeriod(value: unknown, defaultFrom: string): PricingOverridePeriod | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const from = typeof raw.from === 'string' ? raw.from : defaultFrom;
  if (!ISO_DATE.test(from)) return undefined;

  const entry: PricingOverridePeriod = { from };
  let hasRate = false;
  for (const field of KNOWN_OVERRIDE_FIELDS) {
    const v = raw[field];
    if (typeof v === 'number' && Number.isFinite(v)) {
      entry[field] = v;
      hasRate = true;
    }
  }
  return hasRate ? entry : undefined;
}

/** Safe parse for the `pricing_overrides` app setting (JSON object or bust).
 *
 * Each key maps to either a single period (the flat legacy shape, normalised
 * to `from: 1970-01-01`) or an array of dated periods, returned sorted
 * ascending by `from`.
 *
 * Validates each period down to the five known numeric fields: non-object
 * entries are dropped entirely, and any field whose value isn't a finite
 * number (string, NaN, Infinity, unknown key) is dropped. A bad value must
 * never survive to `resolveRates` — a NaN rate produces a NaN cost, and
 * `cost_usd REAL NOT NULL` stores NaN as NULL, aborting the whole backfill
 * insert with nothing louder than a console.warn. */
export function parsePricingOverrides(
  json: string | null | undefined,
): PricingOverrides | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const result: PricingOverrides = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const periods = (Array.isArray(value) ? value : [value])
        .map((v) => parsePeriod(v, LEGACY_FROM))
        .filter((p): p is PricingOverridePeriod => p !== undefined)
        .sort((a, b) => a.from.localeCompare(b.from));
      if (periods.length > 0) result[key] = periods;
    }
    return result;
  } catch {
    return undefined;
  }
}
