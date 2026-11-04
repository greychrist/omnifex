import { describe, it, expect } from 'vitest';
import { loginExpiryState, LOGIN_EXPIRY_WARN_DAYS } from '../loginExpiry';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('loginExpiryState', () => {
  it('is null when the expiry is unknown or there is none', () => {
    expect(loginExpiryState(undefined, NOW)).toBeNull();
    expect(loginExpiryState(null, NOW)).toBeNull();
    expect(loginExpiryState('not a date', NOW)).toBeNull();
  });

  it('is ok beyond the warning window', () => {
    expect(loginExpiryState(at(23 * DAY), NOW)).toMatchObject({ level: 'ok', relative: 'in 23 days' });
  });

  // The CLI starts its own stderr warning 10 days out; match it.
  it('warns inside the CLI-matching window', () => {
    expect(LOGIN_EXPIRY_WARN_DAYS).toBe(10);
    expect(loginExpiryState(at(10 * DAY), NOW)).toMatchObject({ level: 'warning', relative: 'in 10 days' });
    expect(loginExpiryState(at(3 * DAY + 1), NOW)).toMatchObject({ level: 'warning', relative: 'in 3 days' });
  });

  it('is critical in the last two days, counting hours on the last one', () => {
    expect(loginExpiryState(at(2 * DAY), NOW)).toMatchObject({ level: 'critical', relative: 'in 2 days' });
    expect(loginExpiryState(at(1 * DAY), NOW)).toMatchObject({ level: 'critical', relative: 'in 1 day' });
    expect(loginExpiryState(at(5 * 60 * 60 * 1000), NOW)).toMatchObject({ level: 'critical', relative: 'in 5 hours' });
    expect(loginExpiryState(at(20 * 60 * 1000), NOW)).toMatchObject({ level: 'critical', relative: 'in under an hour' });
  });

  it('is expired at or after the end', () => {
    expect(loginExpiryState(at(0), NOW)).toMatchObject({ level: 'expired', relative: 'expired' });
    expect(loginExpiryState(at(-DAY), NOW)).toMatchObject({ level: 'expired', relative: 'expired' });
  });

  it('flags only the levels that warrant a status-bar mark', () => {
    expect(loginExpiryState(at(23 * DAY), NOW)?.alert).toBe(false);
    expect(loginExpiryState(at(9 * DAY), NOW)?.alert).toBe(true);
    expect(loginExpiryState(at(-1), NOW)?.alert).toBe(true);
  });
});
