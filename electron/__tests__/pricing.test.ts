import { describe, it, expect } from 'vitest';
import {
  resolveRates,
  computeMessageCost,
  splitCacheWriteTokens,
  parseLegacyPricingOverrides,
} from '../../src/lib/pricing';

const M = 1_000_000;

describe('resolveRates', () => {
  it('prices current model families', () => {
    expect(resolveRates('claude-fable-5').rates.input).toBeCloseTo(10 / M, 12);
    expect(resolveRates('claude-fable-5').rates.output).toBeCloseTo(50 / M, 12);
    expect(resolveRates('claude-opus-4-8').rates.input).toBeCloseTo(5 / M, 12);
    expect(resolveRates('claude-opus-4-8').rates.output).toBeCloseTo(25 / M, 12);
    expect(resolveRates('claude-sonnet-5').rates.input).toBeCloseTo(2 / M, 12);
    expect(resolveRates('claude-sonnet-5').rates.output).toBeCloseTo(10 / M, 12);
    expect(resolveRates('claude-haiku-4-5-20251001').rates.input).toBeCloseTo(1 / M, 12);
  });

  it('specific patterns beat family patterns (opus-4-8 is not legacy opus)', () => {
    expect(resolveRates('claude-opus-4-1').rates.input).toBeCloseTo(15 / M, 12);
    expect(resolveRates('claude-opus-4-8').rates.input).toBeCloseTo(5 / M, 12);
    expect(resolveRates('claude-3-5-haiku').rates.input).toBeCloseTo(0.25 / M, 12);
  });

  // Sonnet 5 is $2/$10; every earlier Sonnet is $3/$15. One generic
  // 'sonnet' entry priced them all at $3/$15 and overstated Sonnet 5 by 1.5x.
  it('prices Sonnet 5 apart from the older Sonnet family', () => {
    expect(resolveRates('claude-sonnet-5').rates.input).toBeCloseTo(2 / M, 12);
    expect(resolveRates('claude-sonnet-5').rates.output).toBeCloseTo(10 / M, 12);
    expect(resolveRates('claude-sonnet-4-6').rates.input).toBeCloseTo(3 / M, 12);
    expect(resolveRates('claude-sonnet-4-5').rates.input).toBeCloseTo(3 / M, 12);
    // Cache rates derive from input, so they move with it.
    expect(resolveRates('claude-sonnet-5').rates.cacheRead).toBeCloseTo((2 / M) * 0.1, 12);
    expect(resolveRates('claude-sonnet-5').rates.cacheWrite1h).toBeCloseTo((2 / M) * 2, 12);
  });

  it('derives cache rates from input rate', () => {
    const { rates } = resolveRates('claude-opus-4-8');
    expect(rates.cacheRead).toBeCloseTo((5 / M) * 0.1, 12);
    expect(rates.cacheWrite5m).toBeCloseTo((5 / M) * 1.25, 12);
    expect(rates.cacheWrite1h).toBeCloseTo((5 / M) * 2, 12);
  });

  it('unknown model falls back to sonnet rates flagged estimated', () => {
    const r = resolveRates('claude-newthing-9');
    expect(r.estimated).toBe(true);
    expect(r.rates.input).toBeCloseTo(3 / M, 12);
  });

  it('user rows apply per-MTok, longest pattern wins, and clear estimated', () => {
    const rows = [
      { pattern: 'opus', effectiveFrom: '1970-01-01', inputPerM: 99 },
      { pattern: 'opus-4-8', effectiveFrom: '1970-01-01', inputPerM: 4, outputPerM: 20 },
    ];
    const r = resolveRates('claude-opus-4-8', rows);
    expect(r.rates.input).toBeCloseTo(4 / M, 12);
    expect(r.rates.output).toBeCloseTo(20 / M, 12);
    // cache rates re-derive from the overridden input
    expect(r.rates.cacheWrite5m).toBeCloseTo((4 / M) * 1.25, 12);
    const unknown = resolveRates('claude-newthing-9', [
      { pattern: 'newthing', effectiveFrom: '1970-01-01', inputPerM: 7, outputPerM: 30 },
    ]);
    expect(unknown.estimated).toBe(false);
    expect(unknown.rates.input).toBeCloseTo(7 / M, 12);
  });
});

describe('computeMessageCost', () => {
  it('prices all four buckets with the 5m/1h split', () => {
    const c = computeMessageCost('claude-opus-4-8', {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 100_000,
      cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 20_000 },
    });
    expect(c.inputUsd).toBeCloseTo(1000 * (5 / M), 10);
    expect(c.outputUsd).toBeCloseTo(2000 * (25 / M), 10);
    expect(c.cacheReadUsd).toBeCloseTo(100_000 * (5 / M) * 0.1, 10);
    expect(c.cacheWriteUsd).toBeCloseTo(10_000 * (5 / M) * 1.25 + 20_000 * (5 / M) * 2, 10);
    expect(c.usd).toBeCloseTo(c.inputUsd + c.outputUsd + c.cacheReadUsd + c.cacheWriteUsd, 10);
    expect(c.estimated).toBe(false);
  });

  it('falls back to 1.25x for aggregate cache_creation_input_tokens', () => {
    const c = computeMessageCost('claude-sonnet-5', {
      cache_creation_input_tokens: 8000,
    });
    expect(c.cacheWriteUsd).toBeCloseTo(8000 * (2 / M) * 1.25, 10);
  });

  it('empty usage costs zero', () => {
    expect(computeMessageCost('claude-opus-4-8', {}).usd).toBe(0);
  });
});

describe('splitCacheWriteTokens', () => {
  it('uses the split when present, else aggregate as 5m', () => {
    expect(
      splitCacheWriteTokens({ cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 } }),
    ).toEqual({ t5m: 3, t1h: 4 });
    expect(splitCacheWriteTokens({ cache_creation_input_tokens: 9 })).toEqual({ t5m: 9, t1h: 0 });
    expect(splitCacheWriteTokens({})).toEqual({ t5m: 0, t1h: 0 });
  });
});

/**
 * The legacy reader exists only for migration 25, which folds a retired
 * `pricing_overrides` blob into `model_pricing` and deletes it. It returns
 * pricing rows like everything else — there is no second shape.
 */
describe('parseLegacyPricingOverrides', () => {
  it('parses valid JSON, rejects garbage', () => {
    // The flat legacy shape normalises to one always-applicable row.
    expect(parseLegacyPricingOverrides('{"opus-4-8":{"input":4}}')).toEqual([
      { pattern: 'opus-4-8', effectiveFrom: '1970-01-01', inputPerM: 4 },
    ]);
    expect(parseLegacyPricingOverrides('not json')).toBeUndefined();
    expect(parseLegacyPricingOverrides(null)).toBeUndefined();
    expect(parseLegacyPricingOverrides('[1,2]')).toBeUndefined();
  });

  it('drops a string value for a known field, leaving the row empty and dropped', () => {
    expect(parseLegacyPricingOverrides('{"opus":{"input":"5"}}')).toEqual([]);
  });

  it('drops non-finite numbers (Infinity via numeric overflow)', () => {
    expect(parseLegacyPricingOverrides('{"opus":{"input":1e999}}')).toEqual([]);
  });

  it('keeps valid fields alongside dropped ones in the same row', () => {
    expect(parseLegacyPricingOverrides('{"opus":{"input":5,"output":"bad","cacheRead":1e999}}')).toEqual([
      { pattern: 'opus', effectiveFrom: '1970-01-01', inputPerM: 5 },
    ]);
  });

  it('drops a non-object entry entirely while keeping valid siblings', () => {
    expect(parseLegacyPricingOverrides('{"opus":5,"sonnet":{"input":3}}')).toEqual([
      { pattern: 'sonnet', effectiveFrom: '1970-01-01', inputPerM: 3 },
    ]);
  });

  it('drops unknown fields even when numeric', () => {
    expect(parseLegacyPricingOverrides('{"opus":{"input":5,"bogus":1}}')).toEqual([
      { pattern: 'opus', effectiveFrom: '1970-01-01', inputPerM: 5 },
    ]);
  });

  it('ignores fields a blob could never have carried', () => {
    // Fast rates and display metadata arrived with the table. Accepting them
    // here would be validating a shape that cannot occur.
    expect(parseLegacyPricingOverrides('{"opus":{"label":"Opus","colorSlot":1}}')).toEqual([]);
  });
});
