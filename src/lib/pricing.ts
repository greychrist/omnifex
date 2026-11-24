// Shared with the daemon: no Node or DOM APIs.

export interface ModelRates {
  /** USD per token, not per MTok. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Every rate-field list derives from here; hand-kept copies silently stopped round-tripping a column. */
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

/** Omitted fields resolve from the next shorter matching pattern. Rates are USD per million tokens. */
export interface ModelPricingInput {
  pattern: string;
  /** APPEND a row for a price change: editing one in place re-prices every past day on the next rescan. */
  effectiveFrom: string;
  inputPerM?: number;
  outputPerM?: number;
  fastInputPerM?: number;
  fastOutputPerM?: number;
  /** Absolute, for models that escape the cache multiplier; omitted derives it. */
  cacheReadPerM?: number;
  cacheWrite5mPerM?: number;
  cacheWrite1hPerM?: number;
  /** Its version ("Opus 5.5") also ranks the model's shade within its tier. */
  label?: string;
  /** Native window WITHOUT a `[1m]` opt-in, from the CLI's model table (`context.window`), not inferred. */
  contextWindow?: number;
}

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
  speed?: string | null;
}

export interface MessageCost {
  usd: number;
  estimated: boolean;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
}

const MTOK = 1_000_000;

// APPEND a row for a price change: backfill() recomputes cost_usd from tokens, so an in-place edit re-prices
// history. `<synthetic>` is priced at zero explicitly so the unpriced-model warning stays meaningful.
export const SHIPPED_PRICING: ModelPricingInput[] = [
  { pattern: '<synthetic>', effectiveFrom: '2024-01-01', inputPerM: 0, outputPerM: 0 },

  { pattern: 'fable-5-2', effectiveFrom: '2024-01-01', inputPerM: 8, outputPerM: 40, cacheReadPerM: 0.2, label: 'Fable 5.2' },
  { pattern: 'fable-5-1', effectiveFrom: '2024-01-01', inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, label: 'Fable 5.1' },
  { pattern: 'fable-5', effectiveFrom: '2024-01-01', label: 'Fable 5' },
  { pattern: 'fable', effectiveFrom: '2024-01-01', inputPerM: 10, outputPerM: 50, contextWindow: 1_000_000 },

  { pattern: 'mythos-5', effectiveFrom: '2024-01-01', label: 'Mythos 5' },
  { pattern: 'mythos', effectiveFrom: '2024-01-01', inputPerM: 10, outputPerM: 50, contextWindow: 1_000_000 },

  // Known gap: fast-mode cache reads are $0.40 upstream, but `cacheReadPerM` has no fast variant.
  { pattern: 'opus-5-5', effectiveFrom: '2024-01-01', inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, fastInputPerM: 8, fastOutputPerM: 40, label: 'Opus 5.5', contextWindow: 1_000_000 },
  { pattern: 'opus-5', effectiveFrom: '2024-01-01', inputPerM: 5, outputPerM: 25, fastInputPerM: 10, fastOutputPerM: 50, label: 'Opus 5', contextWindow: 1_000_000 },
  { pattern: 'opus-4-8', effectiveFrom: '2024-01-01', inputPerM: 5, outputPerM: 25, fastInputPerM: 10, fastOutputPerM: 50, label: 'Opus 4.8', contextWindow: 1_000_000 },
  { pattern: 'opus-4-7', effectiveFrom: '2024-01-01', inputPerM: 5, outputPerM: 25, label: 'Opus 4.7', contextWindow: 1_000_000 },
  { pattern: 'opus-4-6', effectiveFrom: '2024-01-01', inputPerM: 5, outputPerM: 25, label: 'Opus 4.6' },
  { pattern: 'opus-4-5', effectiveFrom: '2024-01-01', inputPerM: 5, outputPerM: 25, label: 'Opus 4.5' },
  // LEGACY catch-all priced for Opus 3: every modern Opus needs its own row or it bills at 3x.
  { pattern: 'opus', effectiveFrom: '2024-01-01', inputPerM: 15, outputPerM: 75, contextWindow: 200_000 },

  // Known gap: prompts over 100K input bill at $0.50/$2.50 upstream (`long_prompt`); there is no per-request tier.
  { pattern: 'haiku-5-5', effectiveFrom: '2024-01-01', inputPerM: 0.1, outputPerM: 0.5, label: 'Haiku 5.5', contextWindow: 1_000_000 },
  { pattern: 'haiku-4-5', effectiveFrom: '2024-01-01', inputPerM: 1, outputPerM: 5, label: 'Haiku 4.5' },
  { pattern: 'haiku', effectiveFrom: '2024-01-01', inputPerM: 0.25, outputPerM: 1.25, contextWindow: 200_000 },

  { pattern: 'sonnet-4-6', effectiveFrom: '2024-01-01', label: 'Sonnet 4.6' },
  // Only one row per pattern is in force, so a dated row restates the label.
  { pattern: 'sonnet-5-5', effectiveFrom: '2024-01-01', label: 'Sonnet 5.5' },
  { pattern: 'sonnet-5-5', effectiveFrom: '2026-10-09', cacheReadPerM: 0.1, label: 'Sonnet 5.5' },
  { pattern: 'sonnet-5', effectiveFrom: '2024-01-01', inputPerM: 2, outputPerM: 10, label: 'Sonnet 5', contextWindow: 1_000_000 },
  { pattern: 'sonnet', effectiveFrom: '2024-01-01', inputPerM: 3, outputPerM: 15, contextWindow: 200_000 },
];

export interface CacheMultiplierPeriod {
  from: string;
  read: number;
  write5m: number;
  write1h: number;
}

export const CACHE_MULTIPLIERS: CacheMultiplierPeriod[] = [
  { from: '2024-01-01', read: 0.1, write5m: 1.25, write1h: 2 },
];

const DEFAULT_RATES = { inputPerM: 3, outputPerM: 15 };

/** UTC: the basis the daily cost rows are bucketed on. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

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

/** User rows never fall back to the earliest: a future-dated row is a scheduled change, not a retroactive one. */
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
    let list = byPattern.get(p);
    if (!list) {
      list = [];
      byPattern.set(p, list);
    }
    list.push(r);
  }
  return [...byPattern.entries()]
    .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([, group]) => rowInForce(group, date, fallbackToEarliest))
    .filter((r): r is ModelPricingInput => r !== undefined);
}

// A rate and its fast variant resolve together, or a user standard rate inherits the shipped fast premium.
const RATE_GROUPS: readonly (readonly PricingRateField[])[] = [
  ['inputPerM', 'fastInputPerM'],
  ['outputPerM', 'fastOutputPerM'],
  ['cacheReadPerM'],
  ['cacheWrite5mPerM'],
  ['cacheWrite1hPerM'],
];

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
    if (out.contextWindow == null && r.contextWindow != null) out.contextWindow = r.contextWindow;
  }

  return { row: out };
}

export function resolveRates(
  model: string,
  userRows?: readonly ModelPricingInput[] | null,
  opts?: {
    speed?: string | null;
    /** `YYYY-MM-DD`; historical callers must pass each row's own date. */
    date?: string;
  },
): { rates: ModelRates; estimated: boolean } {
  const date = opts?.date ?? today();
  const { row } = resolvePricing(model, date, userRows);
  const fast = opts?.speed === 'fast';

  const inputPerM = (fast ? row.fastInputPerM : undefined) ?? row.inputPerM ?? DEFAULT_RATES.inputPerM;
  const outputPerM = (fast ? row.fastOutputPerM : undefined) ?? row.outputPerM ?? DEFAULT_RATES.outputPerM;

  const input = inputPerM / MTOK;
  const mult = ratePeriodFor(CACHE_MULTIPLIERS, date) ?? CACHE_MULTIPLIERS[0];

  return {
    rates: {
      input,
      output: outputPerM / MTOK,
      cacheRead: row.cacheReadPerM != null ? row.cacheReadPerM / MTOK : input * mult.read,
      cacheWrite5m: row.cacheWrite5mPerM != null ? row.cacheWrite5mPerM / MTOK : input * mult.write5m,
      cacheWrite1h: row.cacheWrite1hPerM != null ? row.cacheWrite1hPerM / MTOK : input * mult.write1h,
    },
    // A label-only row must not clear this: it is the only signal a new model is costed by fallback.
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

/** `input_tokens` alone is only the uncached remainder, and Claude Code caches every request. */
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
  /** Historical callers must pass the row's own date or a rate change re-prices the past. */
  date?: string,
): MessageCost {
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

const LEGACY_FROM = '1970-01-01';

const LEGACY_FIELD_MAP: readonly (readonly [string, PricingRateField])[] = [
  ['input', 'inputPerM'],
  ['output', 'outputPerM'],
  ['cacheRead', 'cacheReadPerM'],
  ['cacheWrite5m', 'cacheWrite5mPerM'],
  ['cacheWrite1h', 'cacheWrite1hPerM'],
];

/** Only for migration 25. Bad values are dropped: a NaN cost stores as NULL in `cost_usd REAL NOT NULL` and aborts the backfill. */
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

export function hasOneMillionSuffix(model: string | null | undefined): boolean {
  return !!model && /\[1m\]/i.test(model);
}

/** Only concrete `claude-*` ids: a bare alias would land on the legacy family row's window. */
export function resolveContextWindow(
  model: string | null | undefined,
  userRows?: readonly ModelPricingInput[] | null,
): number | undefined {
  if (!model || !/^claude-/i.test(model)) return undefined;
  return resolvePricing(model.replace(/\[1m\]$/i, ''), today(), userRows).row.contextWindow;
}

