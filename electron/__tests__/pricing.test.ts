import { describe, it, expect } from 'vitest';
import {
  resolveRates,
  computeMessageCost,
  splitCacheWriteTokens,
  parsePricingOverrides,
} from '../../src/lib/pricing';

const M = 1_000_000;

describe('resolveRates', () => {
  it('prices current model families', () => {
    expect(resolveRates('claude-fable-5').rates.input).toBeCloseTo(10 / M, 12);
    expect(resolveRates('claude-fable-5').rates.output).toBeCloseTo(50 / M, 12);
    expect(resolveRates('claude-opus-4-8').rates.input).toBeCloseTo(5 / M, 12);
    expect(resolveRates('claude-opus-4-8').rates.output).toBeCloseTo(25 / M, 12);
    expect(resolveRates('claude-sonnet-5').rates.input).toBeCloseTo(3 / M, 12);
    expect(resolveRates('claude-haiku-4-5-20251001').rates.input).toBeCloseTo(1 / M, 12);
  });

  it('specific patterns beat family patterns (opus-4-8 is not legacy opus)', () => {
    expect(resolveRates('claude-opus-4-1').rates.input).toBeCloseTo(15 / M, 12);
    expect(resolveRates('claude-opus-4-8').rates.input).toBeCloseTo(5 / M, 12);
    expect(resolveRates('claude-3-5-haiku').rates.input).toBeCloseTo(0.25 / M, 12);
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

  it('overrides apply per-MTok, longest pattern wins, and clear estimated', () => {
    const overrides = { opus: { input: 99 }, 'opus-4-8': { input: 4, output: 20 } };
    const r = resolveRates('claude-opus-4-8', overrides);
    expect(r.rates.input).toBeCloseTo(4 / M, 12);
    expect(r.rates.output).toBeCloseTo(20 / M, 12);
    // cache rates re-derive from overridden input
    expect(r.rates.cacheWrite5m).toBeCloseTo((4 / M) * 1.25, 12);
    const unknown = resolveRates('claude-newthing-9', { newthing: { input: 7, output: 30 } });
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
    expect(c.cacheWriteUsd).toBeCloseTo(8000 * (3 / M) * 1.25, 10);
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

describe('parsePricingOverrides', () => {
  it('parses valid JSON, rejects garbage', () => {
    expect(parsePricingOverrides('{"opus-4-8":{"input":4}}')).toEqual({ 'opus-4-8': { input: 4 } });
    expect(parsePricingOverrides('not json')).toBeUndefined();
    expect(parsePricingOverrides(null)).toBeUndefined();
    expect(parsePricingOverrides('[1,2]')).toBeUndefined();
  });
});
