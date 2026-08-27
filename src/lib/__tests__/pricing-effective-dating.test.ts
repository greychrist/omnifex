import { describe, it, expect } from 'vitest';
import {
  resolveRates,
  computeMessageCost,
  parsePricingOverrides,
  RATE_TABLE,
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
  it('every RATE_TABLE entry has at least one period, sorted or not', () => {
    for (const entry of RATE_TABLE) {
      expect(entry.periods.length).toBeGreaterThan(0);
      for (const p of entry.periods) {
        expect(p.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
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
    const before = computeMessageCost('claude-test-dated', usage, {
      'claude-test-dated': [
        { from: '2024-01-01', input: 3, output: 15 },
        { from: '2026-09-01', input: 2, output: 10 },
      ],
    }, '2026-08-31');
    const after = computeMessageCost('claude-test-dated', usage, {
      'claude-test-dated': [
        { from: '2024-01-01', input: 3, output: 15 },
        { from: '2026-09-01', input: 2, output: 10 },
      ],
    }, '2026-09-01');
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

describe('parsePricingOverrides — period shape', () => {
  it('normalises the flat legacy shape to one always-applicable period', () => {
    const parsed = parsePricingOverrides('{"opus-5":{"input":4,"output":20}}');
    expect(parsed).toEqual({ 'opus-5': [{ from: '1970-01-01', input: 4, output: 20 }] });
  });

  it('accepts an array of dated periods', () => {
    const parsed = parsePricingOverrides(
      '{"opus-5":[{"from":"2026-09-01","input":2},{"from":"2024-01-01","input":5}]}',
    );
    expect(parsed?.['opus-5']).toHaveLength(2);
    expect(parsed?.['opus-5'][0].from).toBe('2024-01-01'); // sorted
  });

  it('drops periods with a malformed from date rather than guessing', () => {
    const parsed = parsePricingOverrides(
      '{"opus-5":[{"from":"nope","input":2},{"from":"2024-01-01","input":5}]}',
    );
    expect(parsed?.['opus-5']).toHaveLength(1);
    expect(parsed?.['opus-5'][0].input).toBe(5);
  });

  it('still rejects non-finite values inside a period', () => {
    const parsed = parsePricingOverrides('{"opus-5":[{"from":"2024-01-01","input":"3","output":20}]}');
    expect(parsed?.['opus-5'][0].input).toBeUndefined();
    expect(parsed?.['opus-5'][0].output).toBe(20);
  });

  it('drops a key whose periods all turn out empty', () => {
    expect(parsePricingOverrides('{"opus-5":[{"from":"2024-01-01"}]}')).toEqual({});
  });

  it('an override wins over the fast-mode rate, as before', () => {
    const { rates } = resolveRates('claude-opus-5', { 'opus-5': [{ from: '1970-01-01', input: 4 }] }, {
      speed: 'fast',
    });
    expect(perM(rates.input)).toBe(4);
  });

  it('an override period that has not started yet does not apply', () => {
    const overrides = { 'opus-5': [{ from: '2027-01-01', input: 99 }] };
    expect(perM(resolveRates('claude-opus-5', overrides, { date: '2026-08-26' }).rates.input)).toBe(5);
    expect(perM(resolveRates('claude-opus-5', overrides, { date: '2027-02-01' }).rates.input)).toBe(99);
  });
});
