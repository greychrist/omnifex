import { describe, it, expect, vi } from 'vitest';
import { createLoggingOptions } from '../logging-options';
import { createAccountIdentityVerdict } from '../services/account-identity';
import type { LogEntry } from '../services/logging';

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
    });

    it('always accepts warn and error, whatever the toggles say', () => {
      const { o } = opts();
      expect(o.shouldAccept(entry({ level: 'error', source: 'claude-hooks' }))).toBe(true);
      expect(o.shouldAccept(entry({ level: 'warn', source: 'usage-runner' }))).toBe(true);
    });

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

    it('reports who is signed in even when there is nothing to check against', () => {
      const { fn } = verdict({ expected_email: null }, 'a@b.com');
      expect(fn('/cfg/personal')).toMatchObject({ status: 'unverified', expected: null, detected: 'a@b.com' });
    });

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
