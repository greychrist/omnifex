import { describe, it, expect } from 'vitest';
import { normalizeThinkingConfig } from '../thinkingConfig';

describe('normalizeThinkingConfig', () => {
  it("maps the legacy 'budget' value to 'adaptive'", () => {
    expect(normalizeThinkingConfig('budget')).toBe('adaptive');
  });

  it("passes 'adaptive' through unchanged", () => {
    expect(normalizeThinkingConfig('adaptive')).toBe('adaptive');
  });

  it("passes 'disabled' through unchanged", () => {
    expect(normalizeThinkingConfig('disabled')).toBe('disabled');
  });

  it("defaults to 'adaptive' when given null / undefined / unknown values", () => {
    expect(normalizeThinkingConfig(null)).toBe('adaptive');
    expect(normalizeThinkingConfig(undefined)).toBe('adaptive');
    expect(normalizeThinkingConfig('')).toBe('adaptive');
    expect(normalizeThinkingConfig('something-bogus')).toBe('adaptive');
    expect(normalizeThinkingConfig(42 as unknown)).toBe('adaptive');
  });
});
