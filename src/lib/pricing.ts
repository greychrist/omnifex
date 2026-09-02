// Pure pricing engine — the single source of truth for token→USD conversion.
// Imported by the renderer (per-message footer) and by electron main-process
// services (session cost, usage dashboard, cost history). Must stay free of
// Node and DOM APIs so it type-checks under both tsconfigs.
//
// Rates: docs/superpowers/specs/2026-07-17-session-cost-tracking-design.md §1.
//
// ── One shape, one table, one resolution ──────────────────────────────────
//
// Everything about a model — what its tokens cost, what the Cost Report calls
// it, what colour it gets — is ONE row type (`ModelPricingInput`) appearing in
// exactly two places:
//
//   1. `SHIPPED_PRICING` below — what this build knows.
//   2. The `model_pricing` SQLite table — what the user has said differs.
//
// They are the same shape and go through the same resolver, so adding a model
// is one row in one place, whichever layer it belongs in. `PRICING_FIELDS` is
// the one description of the rate columns; the service, the IPC adapter and
// the editor all derive their field lists from it rather than restating them.

export interface ModelRates {
  /** USD per single token (per-MTok sticker price / 1e6). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/**
 * The one description of a rate field: what it is called on a row, in the
 * database, and in the editor.
 *
 * Four hand-maintained copies of this list existed briefly (parser, row
 * converter, service, editor) and that is exactly how a column silently stops
 * round-tripping — the value saves, reads back as null, and the cost is quietly
 * wrong. Everything derives from here now. `electron/__tests__/model-pricing`
 * asserts the real table's columns still match.
 */
export const PRICING_FIELDS = [
  { row: 'inputPerM', column: 'input_per_m', label: 'Input' },
  { row: 'outputPerM', column: 'output_per_m', label: 'Output' },
  { row: 'fastInputPerM', column: 'fast_input_per_m', label: 'Fast in' },
  { row: 'fastOutputPerM', column: 'fast_output_per_m', label: 'Fast out' },
  { row: 'cacheReadPerM', column: 'cache_read_per_m', label: 'Cache read' },
  { row: 'cacheWrite5mPerM', column: 'cache_write_5m_per_m', label: 'Write 5m' },
  { row: 'cacheWrite1hPerM', column: 'cache_write_1h_per_m', label: 'Write 1h' },
] as const;

export type PricingRateField = (typeof PRICING_FIELDS)[number]['row'];

/**
 * One model pricing row — the single row shape, shared by the shipped table
 * and the user's `model_pricing` table.
 *
 * A row states only what it knows. Fields it omits resolve from the next
 * shorter matching pattern, so correcting one wrong number is a one-field row
 * rather than a restated model, and a display-only row (`sonnet-4-6`, which
 * prices through the generic `sonnet` row but needs its own legend name) needs
 * no rates at all.
 *
 * Rates are USD per million tokens.
 */
export interface ModelPricingInput {
  /** Model-id substring, lowercased. Longest match wins. */
  pattern: string;
  /** `YYYY-MM-DD`, inclusive. `1970-01-01` means "always". APPEND a row for a
   *  price change; editing one in place re-prices every past day at the new
   *  rate the next time costs are rescanned. */
  effectiveFrom: string;
  inputPerM?: number;
  outputPerM?: number;
  /** Fast-mode rates, for the models that have one. */
  fastInputPerM?: number;
  fastOutputPerM?: number;
  /** Absolute, for models that escape the standard cache multiplier — Fable
   *  5.1 reads at $0.25/MTok on a $10/MTok input rate. Omitted derives it. */
  cacheReadPerM?: number;
  cacheWrite5mPerM?: number;
  cacheWrite1hPerM?: number;
  /** Cost Report legend label. */
  label?: string;
  /** Index into the Cost Report palette; omitted keeps the stable hash. */
  colorSlot?: number;
}

/** A persisted row — the shipped table's entries have no id, being code. */
export interface ModelPricingRow extends ModelPricingInput {
  id: number;
  updatedAt: string;
}

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
  /** True when no layer priced the model and the sonnet-tier default applied. */
  estimated: boolean;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
}

const MTOK = 1_000_000;

/**
 * What this build ships knowing. The base layer under the user's
 * `model_pricing` rows, and — unlike a seeded copy of it — improved by every
 * release, so a model nobody has overridden always tracks the build.
 *
 * RATES ARE EFFECTIVE-DATED. When a price changes, APPEND a row with the
 * effective date rather than editing one: `backfill()` recomputes `cost_usd`
 * from tokens, so an in-place edit re-prices all of history on the next
 * rescan. Appending prices the days before the change at the old rate and the
 * days after at the new one, which is the entire point.
 *
 * Order does not matter — resolution is longest-pattern-first, then
 * field-by-field down to shorter matches. That is what lets `sonnet-4-6` carry
 * a legend name with no rates and still price through `sonnet`, and what makes
 * the bare `opus` row a safe legacy catch-all (priced for Opus 3) under the
 * specific `opus-4-x` rows rather than a hazard above them.
 *
 * `<synthetic>` is a CLI bookkeeping record that carries no usage. It is
 * priced at zero EXPLICITLY rather than left unmatched, so the unpriced-model
 * warning stays meaningful — a flag that fires on every scan is a flag nobody
 * reads.
 */
export const SHIPPED_PRICING: ModelPricingInput[] = [
  { pattern: '<synthetic>', effectiveFrom: '2024-01-01', inputPerM: 0, outputPerM: 0 },

  // Fable 5.1 (CLI 2.1.257) is the first model to break the cache formula:
  // same $10/$50 as Fable 5, but cache reads are $0.25/MTok rather than the
  // 0.1x-input $1.00 every other model gets. Pricing it by the multiplier
  // overstates real Fable 5.1 spend 4x, on the token class that dominates
  // volume in long sessions.
  //
  // It takes slot 7 rather than Fable 5's green. Colour follows the ENTITY:
  // repainting Fable 5 would make every existing Cost Report screenshot
  // disagree with the next one. Slot 7 is shared with Mythos 5, which is
  // Glasswing-only — the two will not appear on one chart, and the slot is
  // editable per-row in Settings > Pricing if they ever do.
  { pattern: 'fable-5-1', effectiveFrom: '2024-01-01', inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, label: 'Fable 5.1', colorSlot: 7 },
  { pattern: 'fable-5', effectiveFrom: '2024-01-01', label: 'Fable 5', colorSlot: 2 },
  { pattern: 'fable', effectiveFrom: '2024-01-01', inputPerM: 10, outputPerM: 50 },

  { pattern: 'mythos-5', effectiveFrom: '2024-01-01', label: 'Mythos 5', colorSlot: 7 },
  { pattern: 'mythos', effectiveFrom: '2024-01-01', inputPerM: 10, outputPerM: 50 },

  // Fast-mode rates are set only on the models that actually have one (Opus 5
  // and Opus 4.8; 4.7's was removed upstream).
  { pattern: 'opus-5', effectiveFrom: '2024-01-01', inputPerM: 5, outputPerM: 25, fastInputPerM: 10, fastOutputPerM: 50, label: 'Opus 5', colorSlot: 1 },
  { pattern: 'opus-4-8', effectiveFrom: '2024-01-01', inputPerM: 5, outputPerM: 25, fastInputPerM: 10, fastOutputPerM: 50, label: 'Opus 4.8', colorSlot: 0 },
  { pattern: 'opus-4-7', effectiveFrom: '2024-01-01', inputPerM: 5, outputPerM: 25, label: 'Opus 4.7', colorSlot: 6 },
  { pattern: 'opus-4-6', effectiveFrom: '2024-01-01', inputPerM: 5, outputPerM: 25, label: 'Opus 4.6', colorSlot: 6 },
  { pattern: 'opus-4-5', effectiveFrom: '2024-01-01', inputPerM: 5, outputPerM: 25, label: 'Opus 4.5', colorSlot: 6 },
  // LEGACY catch-all, priced for Opus 3. Every modern Opus needs its own row:
  // `claude-opus-5` matched none of the `opus-4-x` patterns once and fell
  // through to 15/75, inflating its cost 3x.
  { pattern: 'opus', effectiveFrom: '2024-01-01', inputPerM: 15, outputPerM: 75 },

  { pattern: 'haiku-4-5', effectiveFrom: '2024-01-01', inputPerM: 1, outputPerM: 5, label: 'Haiku 4.5', colorSlot: 4 },
  { pattern: 'haiku', effectiveFrom: '2024-01-01', inputPerM: 0.25, outputPerM: 1.25 },

  { pattern: 'sonnet-4-6', effectiveFrom: '2024-01-01', label: 'Sonnet 4.6', colorSlot: 5 },
  // Sonnet 5 is cheaper than every Sonnet before it. The $2/$10 launched as
  // introductory pricing "through 2026-08-31"; that became the standard price
  // and the scheduled rise to $3/$15 was cancelled, so there is one period,
  // not two. A single generic entry priced Sonnet 5 at $3/$15 once and
  // overstated it by 1.5x.
  { pattern: 'sonnet-5', effectiveFrom: '2024-01-01', inputPerM: 2, outputPerM: 10, label: 'Sonnet 5', colorSlot: 3 },
  { pattern: 'sonnet', effectiveFrom: '2024-01-01', inputPerM: 3, outputPerM: 15 },
];

/** Cache pricing as multipliers on the input rate, effective-dated for the
 *  same reason the rates themselves are. Output tokens are never cached.
 *  A row's absolute `cacheReadPerM` overrides this formula entirely. */
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

/**
 * The row in force on `date` for one pattern.
 *
 * `fallbackToEarliest` is the difference between the two layers, and it is
 * deliberate. For the SHIPPED table a date before every row still prices at
 * the earliest known rate, for the reason above. For USER rows it must not:
 * a row dated in the future is a scheduled price change, and applying it
 * retroactively would silently re-price history the user never asked to touch.
 */
function rowInForce(
  rows: readonly ModelPricingInput[],
  date: string,
  fallbackToEarliest: boolean,
): ModelPricingInput | undefined {
  let best: ModelPricingInput | undefined;
  let earliest: ModelPricingInput | undefined;
  for (const r of rows) {
    if (!earliest || r.effectiveFrom < earliest.effectiveFrom) earliest = r;
    if (r.effectiveFrom <= date && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  }
  return best ?? (fallbackToEarliest ? earliest : undefined);
}

/**
 * Every row matching `model`, longest pattern first, one row per pattern (the
 * one in force on `date`).
 *
 * Longest-first replaced "first entry in array order wins". For the shipped
 * set the two agree exactly, but array order is meaningless in a table the
 * user edits, and an implicit ordering contract in a UI-editable list is a bug
 * waiting for its first reordered row.
 */
function matchingRows(
  model: string,
  rows: readonly ModelPricingInput[],
  date: string,
  fallbackToEarliest: boolean,
): ModelPricingInput[] {
  const m = (model || '').toLowerCase();
  const byPattern = new Map<string, ModelPricingInput[]>();
  for (const r of rows) {
    const p = r.pattern.toLowerCase();
    if (!p || !m.includes(p)) continue;
    (byPattern.get(p) ?? byPattern.set(p, []).get(p)!).push(r);
  }
  return [...byPattern.entries()]
    .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([, group]) => rowInForce(group, date, fallbackToEarliest))
    .filter((r): r is ModelPricingInput => r !== undefined);
}

/**
 * Fields that must resolve together.
 *
 * A rate and its fast-mode variant are ONE statement about what a token costs,
 * not two. Coalescing them independently lets a user row that sets a standard
 * rate inherit the SHIPPED fast rate and silently bill fast turns at the old
 * premium — `{inputPerM: 1}` on Opus 5 came out at $10/MTok under `speed:
 * 'fast'` because the shipped `fastInputPerM: 10` was still in scope.
 *
 * So the most specific row that says anything about input rates says all of
 * them. The cache fields have no paired variant and stand alone.
 */
const RATE_GROUPS: ReadonlyArray<readonly PricingRateField[]> = [
  ['inputPerM', 'fastInputPerM'],
  ['outputPerM', 'fastOutputPerM'],
  ['cacheReadPerM'],
  ['cacheWrite5mPerM'],
  ['cacheWrite1hPerM'],
];

/**
 * The effective row for a model: user rows first, then shipped, coalesced
 * group by group so the most specific statement of each wins.
 *
 * This is the whole precedence system, in one place. A user row that sets only
 * `cacheReadPerM` keeps the shipped input/output; a shipped display-only row
 * keeps its label while pricing through a shorter pattern.
 */
export function resolvePricing(
  model: string,
  date: string,
  userRows?: readonly ModelPricingInput[] | null,
): { row: ModelPricingInput } {
  const layers = [
    userRows?.length ? matchingRows(model, userRows, date, false) : [],
    matchingRows(model, SHIPPED_PRICING, date, true),
  ];
  const ordered = layers.flat();

  const out: ModelPricingInput = { pattern: ordered[0]?.pattern ?? '', effectiveFrom: date };

  for (const group of RATE_GROUPS) {
    const source = ordered.find((r) => group.some((f) => r[f] != null));
    if (!source) continue;
    for (const field of group) {
      if (source[field] != null) out[field] = source[field];
    }
  }

  for (const r of ordered) {
    if (out.label == null && r.label != null) out.label = r.label;
    if (out.colorSlot == null && r.colorSlot != null) out.colorSlot = r.colorSlot;
  }

  return { row: out };
}

export function resolveRates(
  model: string,
  userRows?: readonly ModelPricingInput[] | null,
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
  const date = opts?.date ?? today();
  const { row } = resolvePricing(model, date, userRows);
  const fast = opts?.speed === 'fast';

  const inputPerM = (fast ? row.fastInputPerM : undefined) ?? row.inputPerM ?? DEFAULT_RATES.inputPerM;
  const outputPerM = (fast ? row.fastOutputPerM : undefined) ?? row.outputPerM ?? DEFAULT_RATES.outputPerM;

  const input = inputPerM / MTOK;
  // ratePeriodFor never returns undefined for a non-empty list, and
  // CACHE_MULTIPLIERS is a module constant with at least one entry.
  const mult = ratePeriodFor(CACHE_MULTIPLIERS, date)!;

  return {
    rates: {
      input,
      output: outputPerM / MTOK,
      // An absolute rate is a fact about the model, not a derivation, so it
      // survives a user row that restates input without mentioning cache.
      cacheRead: row.cacheReadPerM != null ? row.cacheReadPerM / MTOK : input * mult.read,
      cacheWrite5m: row.cacheWrite5mPerM != null ? row.cacheWrite5mPerM / MTOK : input * mult.write5m,
      cacheWrite1h: row.cacheWrite1hPerM != null ? row.cacheWrite1hPerM / MTOK : input * mult.write1h,
    },
    // Unpriced means no layer stated a standard rate — the sonnet-tier
    // default is carrying the number. A label-only row must not clear this;
    // it is the only signal a new model is being costed by fallback.
    estimated: row.inputPerM == null && row.outputPerM == null,
  };
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
  userRows?: readonly ModelPricingInput[] | null,
  /** Billing day, `YYYY-MM-DD`; defaults to today. Historical callers must
   *  pass the row's own date or a rate change re-prices the past. */
  date?: string,
): MessageCost {
  // A user row wins over the fast-mode rate — it is a deliberate statement
  // about what a token costs, so fast mode must not silently double it.
  const { rates, estimated } = resolveRates(model, userRows, { speed: usage.speed, date });
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Flat legacy overrides predate effective dating; treat them as always
 *  applicable so an imported setting keeps meaning what it meant. */
const LEGACY_FROM = '1970-01-01';

/** The legacy blob's field names, which differ from the row's. This mapping
 *  exists only to read the retired `pricing_overrides` setting; nothing writes
 *  this shape any more. */
const LEGACY_FIELD_MAP: ReadonlyArray<readonly [string, PricingRateField]> = [
  ['input', 'inputPerM'],
  ['output', 'outputPerM'],
  ['cacheRead', 'cacheReadPerM'],
  ['cacheWrite5m', 'cacheWrite5mPerM'],
  ['cacheWrite1h', 'cacheWrite1hPerM'],
];

/**
 * Read the retired `pricing_overrides` app setting into pricing rows.
 *
 * ONLY used by migration 25, which folds an existing blob into `model_pricing`
 * and deletes it. Nothing else reads this shape, and nothing writes it — do
 * not reach for it as a general parser.
 *
 * It handles exactly the fields the blob could ever have contained: the five
 * original rates. Fast-mode rates and display metadata came in with the table
 * and never existed in a blob, so accepting them here would be validating a
 * shape that cannot occur.
 *
 * Bad values are dropped rather than passed through: a NaN rate produces a NaN
 * cost, and `cost_usd REAL NOT NULL` stores NaN as NULL, aborting the whole
 * backfill insert with nothing louder than a console.warn.
 */
export function parseLegacyPricingOverrides(
  json: string | null | undefined,
): ModelPricingInput[] | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const out: ModelPricingInput[] = [];
  for (const [pattern, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!pattern) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const raw = entry as Record<string, unknown>;
      const effectiveFrom = typeof raw.from === 'string' ? raw.from : LEGACY_FROM;
      // A bad `from` is worse than none: it would silently apply from the
      // wrong day rather than not applying.
      if (!ISO_DATE.test(effectiveFrom)) continue;

      const row: ModelPricingInput = { pattern: pattern.toLowerCase(), effectiveFrom };
      let hasRate = false;
      for (const [legacy, field] of LEGACY_FIELD_MAP) {
        const v = raw[legacy];
        if (typeof v === 'number' && Number.isFinite(v)) {
          row[field] = v;
          hasRate = true;
        }
      }
      if (hasRate) out.push(row);
    }
  }
  return out;
}
