import { describe, it, expect } from 'vitest';
import { decideResumeSeed } from '../resumeSeedDecision';

describe('decideResumeSeed', () => {
  it('seeds on first mount of a fresh session (no live id)', () => {
    expect(
      decideResumeSeed({ sessionId: 'A', claudeSessionId: null, prevSessionId: undefined }),
    ).toBe('reseed');
  });

  it('does nothing when there is no session prop', () => {
    expect(
      decideResumeSeed({ sessionId: null, claudeSessionId: 'A', prevSessionId: undefined }),
    ).toBe('skip');
  });

  it('ignores a stream fork: prop id unchanged, only claudeSessionId advanced', () => {
    // Seeded A on first run; stream advanced claudeSessionId to the fork A'.
    expect(
      decideResumeSeed({ sessionId: 'A', claudeSessionId: "A'", prevSessionId: 'A' }),
    ).toBe('skip');
  });

  it('follows a user switch to a different session even when a live id is set', () => {
    // The bug: opening a new session reassigns the prop while claudeSessionId
    // still holds the previous session's (possibly forked) id. Must reseed.
    expect(
      decideResumeSeed({ sessionId: 'B', claudeSessionId: "A'", prevSessionId: 'A' }),
    ).toBe('reseed');
  });

  it('follows a user switch even when the previous id was nulled by a reset', () => {
    expect(
      decideResumeSeed({ sessionId: 'B', claudeSessionId: null, prevSessionId: 'A' }),
    ).toBe('reseed');
  });

  it('does not stomp a live id on remount over an already-live tab (first sight, non-null)', () => {
    // Component remounted (prev ref reset to undefined) while the store slice
    // still holds the stream-advanced id A'. Must not seed the pre-fork prop A.
    expect(
      decideResumeSeed({ sessionId: 'A', claudeSessionId: "A'", prevSessionId: undefined }),
    ).toBe('skip');
  });

  it('re-seeds after an app reload wiped the store (first sight, null id)', () => {
    expect(
      decideResumeSeed({ sessionId: 'A', claudeSessionId: null, prevSessionId: undefined }),
    ).toBe('reseed');
  });

  it('is idempotent when the prop id is unchanged and already the live id', () => {
    expect(
      decideResumeSeed({ sessionId: 'A', claudeSessionId: 'A', prevSessionId: 'A' }),
    ).toBe('skip');
  });
});
