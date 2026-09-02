import { describe, it, expect } from 'vitest';
import {
  resolveRates,
  computeMessageCost,
  parseLegacyPricingOverrides,
  SHIPPED_PRICING,
  ratePeriodFor,
} from '../pricing';

const MTOK = 1_000_000;
const perM = (rate: number) => Math.round(rate * MTOK * 1e6) / 1e6;

/**
 * Rates are effective-dated: each model maps to a list of periods, and the one
 * that applies to a given day is the period with the latest `from` on or
 * before it. Editing a rate in place instead of appending a period silently
 * re-prices every past row the next time it is re-scanned — the failure mode
 * `scripts/pricing.json` documents at length.
 */
describe('effective-dated rates', () => {
  it('every shipped row has a pattern and a well-formed effective date', () => {
    expect(SHIPPED_PRICING.length).toBeGreaterThan(0);
    for (const row of SHIPPED_PRICING) {
      expect(row.pattern).toBeTruthy();
      expect(row.pattern).toBe(row.pattern.toLowerCase());
      expect(row.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('has no duplicate (pattern, effectiveFrom) — the table\'s primary key', () => {
    const seen = new Set<string>();
    for (const row of SHIPPED_PRICING) {
      const key = `${row.pattern}@${row.effectiveFrom}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('ratePeriodFor picks the latest period on or before the date', () => {
    const periods = [
      { from: '2024-01-01', inputPerM: 3, outputPerM: 15 },
      { from: '2026-09-01', inputPerM: 2, outputPerM: 10 },
      { from: '2027-01-01', inputPerM: 1, outputPerM: 5 },
    ];
    expect(ratePeriodFor(periods, '2026-08-31')?.inputPerM).toBe(3);
    expect(ratePeriodFor(periods, '2026-09-01')?.inputPerM).toBe(2); // boundary is inclusive
    expect(ratePeriodFor(periods, '2026-12-31')?.inputPerM).toBe(2);
    expect(ratePeriodFor(periods, '2027-06-01')?.inputPerM).toBe(1);
  });

  it('falls back to the earliest period for a date before any of them', () => {
    // Rather than reporting the model unpriced. A transcript predating the
    // table is far likelier than a genuinely unknown model.
    const periods = [{ from: '2026-01-01', inputPerM: 7, outputPerM: 35 }];
    expect(ratePeriodFor(periods, '2020-05-05')?.inputPerM).toBe(7);
  });

  it('is order-independent — periods need not be declared sorted', () => {
    const periods = [
      { from: '2027-01-01', inputPerM: 1, outputPerM: 5 },
      { from: '2024-01-01', inputPerM: 3, outputPerM: 15 },
    ];
    expect(ratePeriodFor(periods, '2026-06-01')?.inputPerM).toBe(3);
  });

  it('prices days either side of a rate change differently', () => {
    const usage = { output_tokens: MTOK };
    const rows = [
      { pattern: 'claude-test-dated', effectiveFrom: '2024-01-01', inputPerM: 3, outputPerM: 15 },
      { pattern: 'claude-test-dated', effectiveFrom: '2026-09-01', inputPerM: 2, outputPerM: 10 },
    ];
    const before = computeMessageCost('claude-test-dated', usage, rows, '2026-08-31');
    const after = computeMessageCost('claude-test-dated', usage, rows, '2026-09-01');
    expect(before.usd).toBeCloseTo(15, 9);
    expect(after.usd).toBeCloseTo(10, 9);
  });

  it('omitting the date prices at today, so live-turn callers are unchanged', () => {
    const usage = { output_tokens: MTOK };
    const today = new Date().toISOString().slice(0, 10);
    expect(computeMessageCost('claude-opus-5', usage).usd).toBeCloseTo(
      computeMessageCost('claude-opus-5', usage, undefined, today).usd,
      9,
    );
  });
});

/**
 * The migration to the period shape must be rate-neutral: every model that had
 * a price yesterday has the same price today. A regression here silently
 * re-prices all of history on the next backfill sweep.
 */
describe('rate-neutrality of the period migration', () => {
  const EXPECTED: Record<string, [number, number]> = {
    'claude-fable-5': [10, 50],
    'claude-mythos-5': [10, 50],
    'claude-opus-5': [5, 25],
    'claude-opus-4-8': [5, 25],
    'claude-opus-4-7': [5, 25],
    'claude-opus-4-6': [5, 25],
    'claude-opus-4-5': [5, 25],
    'claude-opus-3': [15, 75],
    'claude-haiku-4-5': [1, 5],
    'claude-haiku-3': [0.25, 1.25],
    'claude-sonnet-5': [2, 10],
    'claude-sonnet-4-6': [3, 15],
  };

  it.each(Object.entries(EXPECTED))('%s still prices at its pre-migration rate', (model, [i, o]) => {
    const { rates, estimated } = resolveRates(model, undefined, { date: '2026-08-26' });
    expect(perM(rates.input)).toBe(i);
    expect(perM(rates.output)).toBe(o);
    expect(estimated).toBe(false);
  });

  it('keeps the fast-mode premium on the models that have one', () => {
    const fast = resolveRates('claude-opus-5', undefined, { speed: 'fast' });
    expect(perM(fast.rates.input)).toBe(10);
    expect(perM(fast.rates.output)).toBe(50);
  });

  it('keeps cache multipliers at read 0.10 / write5m 1.25 / write1h 2.00', () => {
    const { rates } = resolveRates('claude-opus-5');
    expect(perM(rates.cacheRead)).toBeCloseTo(0.5, 9);
    expect(perM(rates.cacheWrite5m)).toBeCloseTo(6.25, 9);
    expect(perM(rates.cacheWrite1h)).toBeCloseTo(10, 9);
  });
});

/**
 * `<synthetic>` records carry no usage and are written by the CLI for
 * bookkeeping. Flagging them as estimated trains the unpriced-model warning to
 * be ignored, which is how a genuinely new model would slip through.
 */
describe('<synthetic>', () => {
  it('is priced at zero and is not flagged as estimated', () => {
    const { rates, estimated } = resolveRates('<synthetic>');
    expect(estimated).toBe(false);
    expect(rates.input).toBe(0);
    expect(rates.output).toBe(0);
    const cost = computeMessageCost('<synthetic>', { input_tokens: 500, output_tokens: 500 });
    expect(cost.usd).toBe(0);
    expect(cost.estimated).toBe(false);
  });

  it('an unknown real model is still flagged', () => {
    expect(resolveRates('claude-brandnew-9').estimated).toBe(true);
  });
});

/**
 * The legacy reader, used only by migration 25 to fold a retired
 * `pricing_overrides` blob into `model_pricing`. It emits pricing rows — the
 * same shape as everything else.
 */
describe('parseLegacyPricingOverrides — row shape', () => {
  it('normalises the flat legacy shape to one always-applicable row', () => {
    expect(parseLegacyPricingOverrides('{"opus-5":{"input":4}}')).toEqual([
      { pattern: 'opus-5', effectiveFrom: '1970-01-01', inputPerM: 4 },
    ]);
  });

  it('accepts an array of dated periods as one row each', () => {
    const parsed = parseLegacyPricingOverrides(
      '{"opus-5":[{"from":"2026-09-01","input":2},{"from":"2024-01-01","input":5}]}',
    );
    expect(parsed).toHaveLength(2);
    expect(parsed?.map((r) => r.effectiveFrom).sort()).toEqual(['2024-01-01', '2026-09-01']);
  });

  it('drops periods with a malformed from date rather than guessing', () => {
    const parsed = parseLegacyPricingOverrides(
      '{"opus-5":[{"from":"nope","input":2},{"from":"2024-01-01","input":5}]}',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].inputPerM).toBe(5);
  });

  it('still rejects non-finite values inside a period', () => {
    const parsed = parseLegacyPricingOverrides('{"opus-5":[{"from":"2024-01-01","input":"3","output":20}]}');
    expect(parsed?.[0].inputPerM).toBeUndefined();
    expect(parsed?.[0].outputPerM).toBe(20);
  });

  it('drops a row that states no rate', () => {
    expect(parseLegacyPricingOverrides('{"opus-5":[{"from":"2024-01-01"}]}')).toEqual([]);
  });

  it('a user row wins over the fast-mode rate, as before', () => {
    const { rates } = resolveRates(
      'claude-opus-5',
      [{ pattern: 'opus-5', effectiveFrom: '1970-01-01', inputPerM: 4 }],
      { speed: 'fast' },
    );
    expect(perM(rates.input)).toBe(4);
  });

  it('a user row that has not started yet does not apply', () => {
    const rows = [{ pattern: 'opus-5', effectiveFrom: '2027-01-01', inputPerM: 99 }];
    expect(perM(resolveRates('claude-opus-5', rows, { date: '2026-08-26' }).rates.input)).toBe(5);
    expect(perM(resolveRates('claude-opus-5', rows, { date: '2027-02-01' }).rates.input)).toBe(99);
  });
});

/**
 * A genuinely new model must need no release: one row has to carry everything
 * — rates, fast-mode rates, legend name and colour.
 */
describe('a user row covers a whole new model', () => {
  it('carries fast-mode rates so a fast-capable new model needs no rebuild', () => {
    const rows = [{ pattern: 'brandnew-9', effectiveFrom: '1970-01-01', inputPerM: 7, outputPerM: 35, fastInputPerM: 14, fastOutputPerM: 70 }];
    const std = resolveRates('claude-brandnew-9', rows);
    expect(perM(std.rates.input)).toBe(7);
    expect(perM(std.rates.output)).toBe(35);
    const fast = resolveRates('claude-brandnew-9', rows, { speed: 'fast' });
    expect(perM(fast.rates.input)).toBe(14);
    expect(perM(fast.rates.output)).toBe(70);
    expect(fast.estimated).toBe(false);
  });

  it('falls back to the standard rate when a row sets no fast rate', () => {
    const rows = [{ pattern: 'brandnew-9', effectiveFrom: '1970-01-01', inputPerM: 7, outputPerM: 35 }];
    expect(perM(resolveRates('claude-brandnew-9', rows, { speed: 'fast' }).rates.input)).toBe(7);
  });

  it('carries an absolute cacheRead while inheriting input/output from the shipped table', () => {
    // The Fable 5.1 shape: one field changes, everything else stays.
    const rows = [{ pattern: 'fable-5', effectiveFrom: '1970-01-01', cacheReadPerM: 0.25 }];
    const { rates } = resolveRates('claude-fable-5', rows);
    expect(perM(rates.input)).toBe(10);
    expect(perM(rates.output)).toBe(50);
    expect(perM(rates.cacheRead)).toBe(0.25);
  });

  it('a label-only row does not clear the unpriced flag', () => {
    // That flag is the one signal a new model is being costed at the default.
    const rows = [{ pattern: 'brandnew-9', effectiveFrom: '1970-01-01', label: 'Brand New 9' }];
    const r = resolveRates('claude-brandnew-9', rows);
    expect(r.estimated).toBe(true);
    expect(perM(r.rates.input)).toBe(3);
  });

  it('a user row restating input does not wipe a shipped ABSOLUTE cache rate', () => {
    // Fable 5.1 reads at $0.25/MTok. Bumping its input must not silently
    // replace that with the 0.1x formula the row exists to escape.
    const rows = [{ pattern: 'fable-5-1', effectiveFrom: '1970-01-01', inputPerM: 12 }];
    const { rates } = resolveRates('claude-fable-5-1', rows);
    expect(perM(rates.input)).toBe(12);
    expect(perM(rates.cacheRead)).toBe(0.25);
  });
});
