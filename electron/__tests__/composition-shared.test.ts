import { describe, it, expect, vi } from 'vitest';
import { createLoggingOptions } from '../logging-options';
import { createAccountIdentityVerdict } from '../services/account-identity';
import type { LogEntry } from '../services/logging';

/**
 * The small blocks both composition roots need.
 *
 * `electron/main.ts` and `electron/remote/daemon.ts` build the same service
 * graph, so every callback handed to a shared service was written twice. These
 * two are the last of the behavioural ones: the log-toast gate and the
 * account-identity verdict. Both were comment-stripped hand copies — the
 * rationale for each rule survived in main.ts only.
 */
describe('shared composition-root blocks', () => {
  describe('logging options', () => {
    function opts(settings: Record<string, string> = {}) {
      const sent: { channel: string; payload: unknown }[] = [];
      const o = createLoggingOptions({
        db: { getSetting: (k: string) => settings[k] ?? null },
        sendToRenderer: (channel, payload) => { sent.push({ channel, payload }); },
      });
      return { o, sent };
    }

    const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
      timestamp: '2026-09-11T00:00:00.000Z',
      level: 'info',
      source: 'backend',
      message: 'hello',
      ...over,
    }) as LogEntry;

    /** Warn and error always pass; only info/debug are ever filtered. */
    it('always accepts warn and error, whatever the toggles say', () => {
      const { o } = opts();
      expect(o.shouldAccept(entry({ level: 'error', source: 'claude-hooks' }))).toBe(true);
      expect(o.shouldAccept(entry({ level: 'warn', source: 'usage-runner' }))).toBe(true);
    });

    /** Defaults are off: these two sources are noisy, and nobody asked. */
    it('drops info and debug from the noisy sources until opted in', () => {
      const { o } = opts();
      expect(o.shouldAccept(entry({ source: 'claude-hooks' }))).toBe(false);
      expect(o.shouldAccept(entry({ level: 'debug', source: 'usage-runner' }))).toBe(false);
      expect(o.shouldAccept(entry({ source: 'backend' }))).toBe(true);
    });

    it('accepts a noisy source once its verbose toggle is on', () => {
      const { o } = opts({ log_verbose_claude_hooks: 'true' });
      expect(o.shouldAccept(entry({ source: 'claude-hooks' }))).toBe(true);
      expect(o.shouldAccept(entry({ source: 'usage-runner' }))).toBe(false);
    });

    /**
     * The error toast defaults ON, so a fresh install still toasts. Only an
     * explicit 'false' suppresses it — a missing setting must not read as off.
     */
    it('toasts an error when the setting is missing', () => {
      const { o, sent } = opts();
      o.onError(entry({ level: 'error', category: 'spawn' }));
      expect(sent).toEqual([
        {
          channel: 'log-error',
          payload: {
            source: 'backend',
            message: 'hello',
            category: 'spawn',
            level: 'error',
            timestamp: '2026-09-11T00:00:00.000Z',
          },
        },
      ]);
    });

    it('suppresses the toast only on an explicit false', () => {
      const { o, sent } = opts({ log_error_toast_enabled: 'false' });
      o.onError(entry({ level: 'error' }));
      expect(sent).toEqual([]);
    });
  });

  describe('account identity verdict', () => {
    function verdict(account: { expected_email?: string | null } | null, email: string | null) {
      const writeBatch = vi.fn();
      const fn = createAccountIdentityVerdict({
        accounts: { getAccountByConfigDir: () => account },
        readIdentity: () => (email === null ? null : { email }),
        log: { writeBatch },
      });
      return { fn, writeBatch };
    }

    it('reports verified when the detected email is the expected one', () => {
      const { fn } = verdict({ expected_email: 'a@b.com' }, 'a@b.com');
      expect(fn('/cfg/personal')).toMatchObject({
        status: 'verified', expected: 'a@b.com', detected: 'a@b.com', configDir: '/cfg/personal',
      });
    });

    it('reports a mismatch when a different account is signed in', () => {
      const { fn } = verdict({ expected_email: 'a@b.com' }, 'other@b.com');
      expect(fn('/cfg/personal').status).toBe('mismatch');
    });

    /** Cheap by construction: no expectation means the file is never read. */
    it('does not read the identity file when there is nothing to check against', () => {
      const readIdentity = vi.fn(() => ({ email: 'a@b.com' }));
      const fn = createAccountIdentityVerdict({
        accounts: { getAccountByConfigDir: () => ({ expected_email: null }) },
        readIdentity,
        log: { writeBatch: vi.fn() },
      });

      expect(fn('/cfg/personal').detected).toBeNull();
      expect(readIdentity).not.toHaveBeenCalled();
    });

    /**
     * The load-bearing one. A config dir no account owns cannot be checked,
     * and that is indistinguishable from "passed" unless it is said out loud —
     * a routing or path-normalization bug would otherwise silently disable
     * verification while looking like a clean bill of health.
     */
    it('logs a warning when no account owns the config dir', () => {
      const { fn, writeBatch } = verdict(null, null);

      expect(fn('/cfg/orphan').status).toBe('unknown-account');
      expect(writeBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          level: 'warn',
          source: 'backend',
          category: 'account-identity',
          message: 'identity check skipped: no account owns configDir=/cfg/orphan',
        }),
      ]);
    });

    it('stays silent for a config dir an account does own', () => {
      const { fn, writeBatch } = verdict({ expected_email: 'a@b.com' }, 'a@b.com');
      fn('/cfg/personal');
      expect(writeBatch).not.toHaveBeenCalled();
    });
  });
});
