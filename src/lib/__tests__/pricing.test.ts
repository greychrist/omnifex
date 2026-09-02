import { describe, it, expect } from 'vitest';
import { resolveRates, computeMessageCost, totalInputTokens } from '../pricing';

const MTOK = 1_000_000;

/** Dollars per MTok, recovered from the per-token rate. */
const perM = (rate: number) => Math.round(rate * MTOK * 100) / 100;

describe('resolveRates — Opus 5', () => {
  // Opus 5 shipped at Opus 4.8's pricing. Before this was fixed, `claude-opus-5`
  // matched none of the `opus-4-x` rows and fell through to the bare `opus`
  // catch-all at 15/75 — inflating every cost figure threefold on what is now
  // the default Opus model.
  it('prices claude-opus-5 at $5/$25, not the legacy opus catch-all', () => {
    const { rates, estimated } = resolveRates('claude-opus-5');
    expect(perM(rates.input)).toBe(5);
    expect(perM(rates.output)).toBe(25);
    expect(estimated).toBe(false);
  });

  it('still matches with the UI [1m] suffix and a dated id', () => {
    expect(perM(resolveRates('opus-5[1m]').rates.input)).toBe(5);
    expect(perM(resolveRates('claude-opus-5-20260715').rates.input)).toBe(5);
  });

  it('does not swallow the older opus-4-x ids', () => {
    for (const id of ['claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']) {
      expect(perM(resolveRates(id).rates.input)).toBe(5);
      expect(perM(resolveRates(id).rates.output)).toBe(25);
    }
  });

  it('leaves the legacy catch-all in place for genuinely old opus ids', () => {
    const { rates } = resolveRates('claude-3-opus-20240229');
    expect(perM(rates.input)).toBe(15);
    expect(perM(rates.output)).toBe(75);
  });
});

describe('resolveRates — fast mode', () => {
  it('prices Opus 5 fast mode at $10/$50', () => {
    const { rates } = resolveRates('claude-opus-5', undefined, { speed: 'fast' });
    expect(perM(rates.input)).toBe(10);
    expect(perM(rates.output)).toBe(50);
  });

  it('prices Opus 4.8 fast mode at $10/$50', () => {
    const { rates } = resolveRates('claude-opus-4-8', undefined, { speed: 'fast' });
    expect(perM(rates.input)).toBe(10);
    expect(perM(rates.output)).toBe(50);
  });

  it('ignores speed on a model with no fast-mode rate rather than inventing one', () => {
    // Fast mode is Opus 5 / Opus 4.8 only; 4.7's was removed upstream.
    const { rates } = resolveRates('claude-opus-4-7', undefined, { speed: 'fast' });
    expect(perM(rates.input)).toBe(5);
    expect(perM(rates.output)).toBe(25);
  });

  it('leaves standard speed alone', () => {
    const { rates } = resolveRates('claude-opus-5', undefined, { speed: 'standard' });
    expect(perM(rates.input)).toBe(5);
  });

  it('derives cache rates from the fast input rate', () => {
    const { rates } = resolveRates('claude-opus-5', undefined, { speed: 'fast' });
    expect(perM(rates.cacheRead)).toBe(1);       // 0.1x
    expect(perM(rates.cacheWrite5m)).toBe(12.5); // 1.25x
    expect(perM(rates.cacheWrite1h)).toBe(20);   // 2x
  });
});

describe('computeMessageCost', () => {
  it('reads speed off the usage block', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    expect(computeMessageCost('claude-opus-5', usage).usd).toBeCloseTo(5, 6);
    expect(
      computeMessageCost('claude-opus-5', { ...usage, speed: 'fast' }).usd,
    ).toBeCloseTo(10, 6);
  });

  it('charges a realistic warm Opus 5 turn at the corrected rate', () => {
    // 480k cached read + 2k output — the shape of a long warm session.
    const cost = computeMessageCost('claude-opus-5', {
      input_tokens: 2,
      output_tokens: 2_000,
      cache_read_input_tokens: 480_000,
    });
    // cache read at 0.1 x $5 = $0.50/MTok  ->  480k = $0.24
    expect(cost.cacheReadUsd).toBeCloseTo(0.24, 6);
    expect(cost.outputUsd).toBeCloseTo(0.05, 6);
  });

  // A user-set override is an explicit statement about rates; fast mode must
  // not silently double it.
  it('lets an explicit override win over the fast-mode rate', () => {
    const cost = computeMessageCost(
      'claude-opus-5',
      { input_tokens: 1_000_000, speed: 'fast' },
      [{ pattern: 'opus-5', effectiveFrom: '1970-01-01', inputPerM: 1 }],
    );
    expect(cost.usd).toBeCloseTo(1, 6);
    expect(cost.estimated).toBe(false);
  });
});

describe('totalInputTokens', () => {
  it('sums the three fields the API splits input across', () => {
    // Real payload shape from a live transcript: with prompt caching on, the
    // bare `input_tokens` field counts only the uncached remainder.
    expect(
      totalInputTokens({
        input_tokens: 2,
        cache_read_input_tokens: 20496,
        cache_creation_input_tokens: 24937,
        output_tokens: 644,
      }),
    ).toBe(45435);
  });

  it('excludes output', () => {
    expect(totalInputTokens({ input_tokens: 10, output_tokens: 9999 })).toBe(10);
  });

  it('treats missing fields as zero', () => {
    expect(totalInputTokens({})).toBe(0);
    expect(totalInputTokens({ cache_read_input_tokens: 5 })).toBe(5);
  });
});

describe('resolveRates — Fable 5.1', () => {
  // Fable 5.1 (2.1.257) ships at Fable 5's $10/$50 but breaks the standard
  // cache formula: reads are $0.25/MTok, not the 0.1x-input $1.00 that every
  // other model gets. Cache reads dominate token volume in long sessions, so
  // pricing it by the multiplier overstates real Fable 5.1 spend 4x.
  it('prices claude-fable-5-1 cache reads at $0.25/MTok, not 0.1x input', () => {
    const { rates, estimated } = resolveRates('claude-fable-5-1');
    expect(perM(rates.input)).toBe(10);
    expect(perM(rates.output)).toBe(50);
    expect(perM(rates.cacheRead)).toBe(0.25);
    expect(estimated).toBe(false);
  });

  it('leaves Fable 5 on the standard 0.1x cache-read multiplier', () => {
    const { rates } = resolveRates('claude-fable-5');
    expect(perM(rates.input)).toBe(10);
    expect(perM(rates.cacheRead)).toBe(1);
  });

  it('keeps the standard cache-write multipliers on Fable 5.1', () => {
    const { rates } = resolveRates('claude-fable-5-1');
    expect(perM(rates.cacheWrite5m)).toBe(12.5);
    expect(perM(rates.cacheWrite1h)).toBe(20);
  });

  it('matches the [1m] suffix and a dated id', () => {
    expect(perM(resolveRates('claude-fable-5-1[1m]').rates.cacheRead)).toBe(0.25);
    expect(perM(resolveRates('claude-fable-5-1-20260901').rates.cacheRead)).toBe(0.25);
  });
});
