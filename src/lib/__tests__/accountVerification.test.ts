import { describe, it, expect } from 'vitest';
import { resolveSessionVerification } from '../accountVerification';
import type { IdentityVerdict } from '@/lib/api';

function verdict(over: Partial<IdentityVerdict> = {}): IdentityVerdict {
  return {
    status: 'verified',
    expected: 'work@example.com',
    detected: 'work@example.com',
    configDir: '/tmp/.claude-work',
    ...over,
  };
}

const BASE = { verdict: verdict(), sessionEmail: null, loaded: true, error: false };

describe('resolveSessionVerification', () => {
  it('returns null when the account opted out of checking', () => {
    expect(
      resolveSessionVerification({
        ...BASE,
        verdict: verdict({ status: 'unverified', expected: null, detected: null }),
      }),
    ).toBeNull();
  });

  it('returns null before the verdict has loaded', () => {
    expect(resolveSessionVerification({ ...BASE, verdict: null, loaded: false })).toBeNull();
  });

  // The session's own identity is the authority: it's what the running CLI
  // process is actually authenticated as.
  describe('when the session reported its own identity (rich mode)', () => {
    it('is verified with no restart when the session matches the expectation', () => {
      const r = resolveSessionVerification({
        ...BASE,
        verdict: verdict({ status: 'mismatch', detected: 'stale@example.com' }),
        sessionEmail: 'work@example.com',
      });
      // Config dir file says mismatch, but the session itself is right —
      // trust the session. Nothing to restart.
      expect(r).toMatchObject({ status: 'verified', needsRestart: false });
    });

    it('matches case-insensitively', () => {
      const r = resolveSessionVerification({
        ...BASE,
        sessionEmail: 'WORK@example.com',
      });
      expect(r?.status).toBe('verified');
    });

    // This is the case Greg called out: the user fixed the *expectation*, so
    // the session was fine all along and must not demand a restart.
    it('goes green with no restart once the expectation is corrected to match the session', () => {
      const r = resolveSessionVerification({
        ...BASE,
        verdict: verdict({ expected: 'greg@work.com', detected: 'greg@work.com' }),
        sessionEmail: 'greg@work.com',
      });
      expect(r).toMatchObject({ status: 'verified', needsRestart: false });
    });

    it('demands a restart when the running session is on the wrong account', () => {
      const r = resolveSessionVerification({
        ...BASE,
        verdict: verdict({ status: 'verified', detected: 'work@example.com' }),
        sessionEmail: 'personal@example.com',
      });
      // Even though the config dir is now correct, the live process still
      // holds the old credentials — re-login alone doesn't fix it.
      expect(r).toMatchObject({
        status: 'mismatch',
        needsRestart: true,
        expected: 'work@example.com',
        detected: 'personal@example.com',
      });
    });
  });

  describe('when the session has no identity to report (TUI mode)', () => {
    it('falls back to the config-dir verdict and demands a restart on mismatch', () => {
      const r = resolveSessionVerification({
        ...BASE,
        verdict: verdict({ status: 'mismatch', detected: 'personal@example.com' }),
        sessionEmail: null,
      });
      expect(r).toMatchObject({
        status: 'mismatch',
        needsRestart: true,
        detected: 'personal@example.com',
      });
    });

    it('demands a restart when the config dir is signed out', () => {
      const r = resolveSessionVerification({
        ...BASE,
        verdict: verdict({ status: 'signed-out', detected: null }),
        sessionEmail: null,
      });
      expect(r).toMatchObject({ status: 'signed-out', needsRestart: true });
    });

    it('is verified with no restart when the config dir matches', () => {
      const r = resolveSessionVerification({ ...BASE, sessionEmail: null });
      expect(r).toMatchObject({ status: 'verified', needsRestart: false });
    });
  });

  describe('states that cannot support a restart claim', () => {
    it('reports unknown-account without demanding a restart', () => {
      const r = resolveSessionVerification({
        ...BASE,
        verdict: verdict({ status: 'unknown-account', expected: null, detected: null }),
      });
      // Nothing owns the config dir — restarting wouldn't fix anything, and
      // the user's login isn't what's wrong.
      expect(r).toMatchObject({ status: 'unknown-account', needsRestart: false });
    });

    it('reports a failed read as unknown-account, not as a mismatch', () => {
      const r = resolveSessionVerification({ ...BASE, verdict: null, error: true });
      expect(r).toMatchObject({ status: 'unknown-account', needsRestart: false });
    });
  });
});
