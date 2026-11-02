import { describe, it, expect } from 'vitest';
import type { RateLimitSnapshot } from '@/lib/api';
import { applyRateLimitUpdate } from '../rateLimitSnapshots';

const snap = (type: string, utilization = 10): RateLimitSnapshot => ({
  account_name: 'Personal', rate_limit_type: type, status: 'allowed',
  utilization, resets_at: null, observed_at: 1,
});

describe('applyRateLimitUpdate', () => {
  const prev = { five_hour: snap('five_hour'), seven_day: snap('seven_day') };

  it('replaces the window a snapshot names', () => {
    const next = applyRateLimitUpdate(prev, { account_name: 'Personal', snapshot: snap('seven_day', 40) }, 'Personal');
    expect(next.seven_day.utilization).toBe(40);
    expect(next.five_hour).toBe(prev.five_hour);
  });

  it('drops a window the daemon says is gone', () => {
    const next = applyRateLimitUpdate(prev, { account_name: 'Personal', removed: 'five_hour' }, 'Personal');
    expect(Object.keys(next)).toEqual(['seven_day']);
  });

  it('ignores another account', () => {
    expect(applyRateLimitUpdate(prev, { account_name: 'Work', removed: 'five_hour' }, 'Personal')).toBe(prev);
  });

  it('ignores a payload with neither', () => {
    expect(applyRateLimitUpdate(prev, { account_name: 'Personal' }, 'Personal')).toBe(prev);
    expect(applyRateLimitUpdate(prev, undefined, 'Personal')).toBe(prev);
  });

  it('returns the same object when removing a window it never had', () => {
    const only = { seven_day: snap('seven_day') };
    expect(applyRateLimitUpdate(only, { account_name: 'Personal', removed: 'five_hour' }, 'Personal')).toBe(only);
  });
});
