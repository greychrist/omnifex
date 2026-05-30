import { describe, it, expect } from 'vitest';
import { resolveContextLimit } from '../contextLimit';

describe('resolveContextLimit', () => {
  it('trusts the live CLI maxTokens even when the model string lost its [1m] suffix (resume bug)', () => {
    // This is the reported bug: on resume selectedModel falls back to "opus"
    // (no [1m]), but the live CLI reports the true 1M window. We must NOT clamp
    // the authoritative live number to 200k.
    expect(resolveContextLimit({ sdkMaxTokens: 1_000_000, model: 'opus' })).toBe(1_000_000);
    expect(resolveContextLimit({ sdkMaxTokens: 1_000_000, model: undefined })).toBe(1_000_000);
  });

  it('trusts the live CLI maxTokens for an explicitly-[1m] model', () => {
    expect(resolveContextLimit({ sdkMaxTokens: 1_000_000, model: 'claude-opus-4-8[1m]' })).toBe(1_000_000);
  });

  it('uses the live window verbatim for a standard 200k session', () => {
    expect(resolveContextLimit({ sdkMaxTokens: 200_000, model: 'claude-opus-4-8' })).toBe(200_000);
  });

  it('falls back to 1M for a [1m] model when no live data is available', () => {
    expect(resolveContextLimit({ sdkMaxTokens: null, model: 'claude-opus-4-8[1m]' })).toBe(1_000_000);
  });

  it('falls back to 200k for a non-[1m] / unknown model when no live data is available', () => {
    expect(resolveContextLimit({ sdkMaxTokens: null, model: 'claude-opus-4-8' })).toBe(200_000);
    expect(resolveContextLimit({ sdkMaxTokens: null, model: 'opus' })).toBe(200_000);
    expect(resolveContextLimit({ sdkMaxTokens: null, model: undefined })).toBe(200_000);
  });

  it('treats a non-positive live max as "no live data"', () => {
    expect(resolveContextLimit({ sdkMaxTokens: 0, model: 'claude-opus-4-8[1m]' })).toBe(1_000_000);
  });
});
