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

  it('uses the account default model to detect a 1M window when the session model lost its [1m] suffix', () => {
    // The reported bug (a resumed chat-mode session before its next turn, where
    // live usage hasn't been fetched): an "Account Default" session never
    // carries [1m] on its own model string (selectedModel is the base id from
    // JSONL, or the "default" sentinel). The account's settings.json `model`
    // ("opus[1m]") is the only signal that the resolved default is a 1M model,
    // so the fallback must honor it.
    expect(
      resolveContextLimit({ sdkMaxTokens: null, model: 'claude-opus-4-8', defaultModel: 'opus[1m]' }),
    ).toBe(1_000_000);
    expect(
      resolveContextLimit({ sdkMaxTokens: null, model: 'default', defaultModel: 'opus[1m]' }),
    ).toBe(1_000_000);
    expect(
      resolveContextLimit({ sdkMaxTokens: null, model: undefined, defaultModel: 'opus[1m]' }),
    ).toBe(1_000_000);
  });

  it('does NOT inherit the 1M default when the session explicitly runs a different model family', () => {
    // Account defaults to opus[1m], but this session was explicitly switched to
    // sonnet. In the fallback we must size against sonnet's window, not 1M.
    expect(
      resolveContextLimit({ sdkMaxTokens: null, model: 'claude-sonnet-4-6', defaultModel: 'opus[1m]' }),
    ).toBe(200_000);
  });

  it('inherits the 1M default for the same family or the default sentinel', () => {
    expect(
      resolveContextLimit({ sdkMaxTokens: null, model: 'claude-opus-4-8', defaultModel: 'opus[1m]' }),
    ).toBe(1_000_000);
    expect(
      resolveContextLimit({ sdkMaxTokens: null, model: 'opus', defaultModel: 'opus[1m]' }),
    ).toBe(1_000_000);
    expect(
      resolveContextLimit({ sdkMaxTokens: null, model: 'default', defaultModel: 'opus[1m]' }),
    ).toBe(1_000_000);
  });

  it('ignores a non-[1m] account default model', () => {
    expect(
      resolveContextLimit({ sdkMaxTokens: null, model: 'opus', defaultModel: 'sonnet' }),
    ).toBe(200_000);
    expect(
      resolveContextLimit({ sdkMaxTokens: null, model: 'opus', defaultModel: null }),
    ).toBe(200_000);
  });

  it('still trusts a live window over the account default model heuristic', () => {
    // Live data is authoritative — a 200k live window wins even if the account
    // default looks like a 1M model (e.g. a sub-agent pinned to a smaller window).
    expect(
      resolveContextLimit({ sdkMaxTokens: 200_000, model: 'opus', defaultModel: 'opus[1m]' }),
    ).toBe(200_000);
  });

  it('treats a non-positive live max as "no live data"', () => {
    expect(resolveContextLimit({ sdkMaxTokens: 0, model: 'claude-opus-4-8[1m]' })).toBe(1_000_000);
  });
});
