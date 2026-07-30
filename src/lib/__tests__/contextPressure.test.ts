import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTEXT_PRESSURE,
  ABSOLUTE_BUDGET_WINDOW_FRACTION,
  parseContextPressureMode,
  parseContextPressureValue,
  clampContextPressureValue,
  evaluateContextPressure,
  selectContextTokens,
  type ContextPressureSetting,
} from '../contextPressure';

const ON = (over: Partial<ContextPressureSetting> = {}): ContextPressureSetting => ({
  ...DEFAULT_CONTEXT_PRESSURE,
  ...over,
});

describe('defaults', () => {
  it('defaults to an absolute 250k-token budget, enabled', () => {
    expect(DEFAULT_CONTEXT_PRESSURE).toEqual({
      enabled: true,
      mode: 'tokens',
      value: 250_000,
    });
  });

  it('clamps absolute budgets to 95% of the window', () => {
    expect(ABSOLUTE_BUDGET_WINDOW_FRACTION).toBe(0.95);
  });
});

describe('parseContextPressureMode', () => {
  it('accepts both known modes', () => {
    expect(parseContextPressureMode('percent')).toBe('percent');
    expect(parseContextPressureMode('tokens')).toBe('tokens');
  });

  it('falls back to the default on null or garbage', () => {
    expect(parseContextPressureMode(null)).toBe('tokens');
    expect(parseContextPressureMode('')).toBe('tokens');
    expect(parseContextPressureMode('PERCENTAGE')).toBe('tokens');
  });
});

describe('parseContextPressureValue', () => {
  it('parses an integer', () => {
    expect(parseContextPressureValue('120000', 'tokens')).toBe(120_000);
    expect(parseContextPressureValue('75', 'percent')).toBe(75);
  });

  it('falls back to the mode default on null or garbage', () => {
    expect(parseContextPressureValue(null, 'tokens')).toBe(250_000);
    expect(parseContextPressureValue('abc', 'tokens')).toBe(250_000);
    expect(parseContextPressureValue(null, 'percent')).toBe(80);
    expect(parseContextPressureValue('nope', 'percent')).toBe(80);
  });

  it('clamps what it parses', () => {
    expect(parseContextPressureValue('0', 'percent')).toBe(1);
    expect(parseContextPressureValue('400', 'percent')).toBe(100);
    expect(parseContextPressureValue('5', 'tokens')).toBe(1_000);
  });
});

describe('clampContextPressureValue', () => {
  it('clamps percent to 1-100', () => {
    expect(clampContextPressureValue(0, 'percent')).toBe(1);
    expect(clampContextPressureValue(-20, 'percent')).toBe(1);
    expect(clampContextPressureValue(101, 'percent')).toBe(100);
    expect(clampContextPressureValue(80, 'percent')).toBe(80);
  });

  it('clamps tokens to a 1000 floor with no ceiling', () => {
    expect(clampContextPressureValue(0, 'tokens')).toBe(1_000);
    expect(clampContextPressureValue(999, 'tokens')).toBe(1_000);
    expect(clampContextPressureValue(5_000_000, 'tokens')).toBe(5_000_000);
  });

  it('floors fractional input', () => {
    expect(clampContextPressureValue(80.7, 'percent')).toBe(80);
    expect(clampContextPressureValue(250_000.9, 'tokens')).toBe(250_000);
  });
});

describe('evaluateContextPressure — percent mode', () => {
  const setting = ON({ mode: 'percent', value: 80 });
  // 80% of a 200k window => budget 160k; warn at 128k.

  it('is none below the warn line', () => {
    expect(evaluateContextPressure({ tokens: 127_999, limit: 200_000, setting }).level).toBe('none');
  });

  it('warns exactly at 80% of the budget', () => {
    const r = evaluateContextPressure({ tokens: 128_000, limit: 200_000, setting });
    expect(r.level).toBe('warn');
    expect(r.budgetTokens).toBe(160_000);
  });

  it('stays warn just under the budget', () => {
    expect(evaluateContextPressure({ tokens: 159_999, limit: 200_000, setting }).level).toBe('warn');
  });

  it('goes critical exactly at the budget', () => {
    expect(evaluateContextPressure({ tokens: 160_000, limit: 200_000, setting }).level).toBe('critical');
  });

  it('stays critical above the budget', () => {
    expect(evaluateContextPressure({ tokens: 199_000, limit: 200_000, setting }).level).toBe('critical');
  });

  it('scales with the window rather than being pinned to 200k', () => {
    const r = evaluateContextPressure({ tokens: 700_000, limit: 1_000_000, setting });
    expect(r.budgetTokens).toBe(800_000);
    expect(r.level).toBe('warn');
  });

  it('reports occupancy against the real window', () => {
    const r = evaluateContextPressure({ tokens: 250_000, limit: 1_000_000, setting });
    expect(r.pct).toBe(25);
  });
});

describe('evaluateContextPressure — tokens mode', () => {
  const setting = ON({ mode: 'tokens', value: 250_000 });

  it('uses the literal budget when it fits the window', () => {
    const r = evaluateContextPressure({ tokens: 250_000, limit: 1_000_000, setting });
    expect(r.budgetTokens).toBe(250_000);
    expect(r.level).toBe('critical');
  });

  it('warns at 80% of the literal budget', () => {
    const r = evaluateContextPressure({ tokens: 200_000, limit: 1_000_000, setting });
    expect(r.level).toBe('warn');
  });

  it('clamps a budget larger than the window to 95% of it', () => {
    // 250k budget on a 200k window => 190k, warn at 152k.
    const r = evaluateContextPressure({ tokens: 152_000, limit: 200_000, setting });
    expect(r.budgetTokens).toBe(190_000);
    expect(r.level).toBe('warn');
    expect(evaluateContextPressure({ tokens: 190_000, limit: 200_000, setting }).level).toBe('critical');
  });

  it('keeps critical reachable below the window ceiling', () => {
    // The whole point of the 0.95 clamp: 200k tokens in a 200k window is not
    // required to trip red, because the CLI auto-compacts before that.
    const r = evaluateContextPressure({ tokens: 191_000, limit: 200_000, setting });
    expect(r.level).toBe('critical');
  });
});

describe('evaluateContextPressure — inert cases', () => {
  // The banner's only action is "run /compact", which needs a live CLI. A
  // resumed session whose transcript loads but whose engine never comes up
  // (e.g. a failed --resume) would otherwise flash an un-actionable banner
  // between 'starting' and 'stopped'.
  it('is none when the session is not live, however full the context', () => {
    const r = evaluateContextPressure({
      tokens: 586_500,
      limit: 1_000_000,
      setting: ON(),
      sessionLive: false,
    });
    expect(r.level).toBe('none');
  });

  it('still fires for the same session once it is live', () => {
    const r = evaluateContextPressure({
      tokens: 586_500,
      limit: 1_000_000,
      setting: ON(),
      sessionLive: true,
    });
    expect(r.level).toBe('critical');
  });

  it('defaults to live so callers that omit it are unaffected', () => {
    expect(
      evaluateContextPressure({ tokens: 586_500, limit: 1_000_000, setting: ON() }).level,
    ).toBe('critical');
  });

  it('is none when disabled', () => {
    const setting = ON({ enabled: false });
    expect(evaluateContextPressure({ tokens: 999_999, limit: 200_000, setting }).level).toBe('none');
  });

  it('is none with no tokens yet', () => {
    expect(evaluateContextPressure({ tokens: 0, limit: 200_000, setting: ON() }).level).toBe('none');
  });

  it('is none with an unknown window', () => {
    expect(evaluateContextPressure({ tokens: 100_000, limit: 0, setting: ON() }).level).toBe('none');
  });
});

describe('selectContextTokens', () => {
  it('prefers the live CLI usage when present', () => {
    expect(
      selectContextTokens({
        contextUsage: { totalTokens: 123_000, maxTokens: 1_000_000 },
        fallbackTokens: 90_000,
      }),
    ).toEqual({ tokens: 123_000, sdkMaxTokens: 1_000_000 });
  });

  it('falls back to the last-assistant-turn estimate when absent', () => {
    expect(
      selectContextTokens({ contextUsage: null, fallbackTokens: 90_000 }),
    ).toEqual({ tokens: 90_000, sdkMaxTokens: null });
  });
});
