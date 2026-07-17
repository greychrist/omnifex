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

/** User-supplied rate override, in USD per MTok (matches published pricing). */
export interface PricingOverride {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

/** Keyed by model-id substring pattern, e.g. { "opus-4-8": { input: 4 } }. */
export type PricingOverrides = Record<string, PricingOverride>;

export interface UsageTokens {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
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

// Ordered most-specific-first; first `model.includes(pattern)` match wins.
const RATE_TABLE: Array<{ pattern: string; inputPerM: number; outputPerM: number }> = [
  { pattern: 'fable', inputPerM: 10, outputPerM: 50 },
  { pattern: 'mythos', inputPerM: 10, outputPerM: 50 },
  { pattern: 'opus-4-5', inputPerM: 5, outputPerM: 25 },
  { pattern: 'opus-4-6', inputPerM: 5, outputPerM: 25 },
  { pattern: 'opus-4-7', inputPerM: 5, outputPerM: 25 },
  { pattern: 'opus-4-8', inputPerM: 5, outputPerM: 25 },
  { pattern: 'opus', inputPerM: 15, outputPerM: 75 },
  { pattern: 'haiku-4-5', inputPerM: 1, outputPerM: 5 },
  { pattern: 'haiku', inputPerM: 0.25, outputPerM: 1.25 },
  { pattern: 'sonnet', inputPerM: 3, outputPerM: 15 },
];

const DEFAULT_RATES = { inputPerM: 3, outputPerM: 15 }; // sonnet-tier fallback

function baseRates(inputPerM: number, outputPerM: number): ModelRates {
  const input = inputPerM / MTOK;
  return {
    input,
    output: outputPerM / MTOK,
    cacheRead: input * 0.1,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
  };
}

export function resolveRates(
  model: string,
  overrides?: PricingOverrides,
): { rates: ModelRates; estimated: boolean } {
  const m = (model || '').toLowerCase();
  const entry = RATE_TABLE.find((e) => m.includes(e.pattern));
  let rates = entry
    ? baseRates(entry.inputPerM, entry.outputPerM)
    : baseRates(DEFAULT_RATES.inputPerM, DEFAULT_RATES.outputPerM);
  let estimated = !entry;

  if (overrides) {
    const key = Object.keys(overrides)
      .sort((a, b) => b.length - a.length)
      .find((k) => k.length > 0 && m.includes(k.toLowerCase()));
    if (key) {
      const o = overrides[key];
      const input = o.input != null ? o.input / MTOK : rates.input;
      rates = {
        input,
        output: o.output != null ? o.output / MTOK : rates.output,
        cacheRead: o.cacheRead != null ? o.cacheRead / MTOK : input * 0.1,
        cacheWrite5m: o.cacheWrite5m != null ? o.cacheWrite5m / MTOK : input * 1.25,
        cacheWrite1h: o.cacheWrite1h != null ? o.cacheWrite1h / MTOK : input * 2,
      };
      estimated = false;
    }
  }
  return { rates, estimated };
}

export function splitCacheWriteTokens(usage: UsageTokens): { t5m: number; t1h: number } {
  const split = usage.cache_creation;
  if (split && (split.ephemeral_5m_input_tokens != null || split.ephemeral_1h_input_tokens != null)) {
    return { t5m: split.ephemeral_5m_input_tokens ?? 0, t1h: split.ephemeral_1h_input_tokens ?? 0 };
  }
  return { t5m: usage.cache_creation_input_tokens ?? 0, t1h: 0 };
}

export function computeMessageCost(
  model: string,
  usage: UsageTokens,
  overrides?: PricingOverrides,
): MessageCost {
  const { rates, estimated } = resolveRates(model, overrides);
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

/** Safe parse for the `pricing_overrides` app setting (JSON object or bust).
 *
 * Validates each entry down to the five known numeric fields: non-object
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
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry: PricingOverride = {};
      for (const field of KNOWN_OVERRIDE_FIELDS) {
        const v = (value as Record<string, unknown>)[field];
        if (typeof v === 'number' && Number.isFinite(v)) {
          entry[field] = v;
        }
      }
      if (Object.keys(entry).length > 0) {
        result[key] = entry;
      }
    }
    return result;
  } catch {
    return undefined;
  }
}
