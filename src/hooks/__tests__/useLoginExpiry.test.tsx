// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { announceAccountSignedIn } from '@/lib/accountSignIn';

const accountLoginExpiry = vi.fn();
const subscribeAccountIdentity = vi.fn((_dir: string, _cb: () => void) => () => {});
vi.mock('@/lib/api', () => ({
  api: {
    accountLoginExpiry: (...a: unknown[]) => accountLoginExpiry(...a),
    subscribeAccountIdentity: (dir: string, cb: () => void) => subscribeAccountIdentity(dir, cb),
  },
}));

import { useLoginExpiry } from '../useLoginExpiry';

const DIR = '/Users/me/.claude-personal';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
  accountLoginExpiry.mockReset();
  subscribeAccountIdentity.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useLoginExpiry', () => {
  it('fetches the expiry and grades it against now', async () => {
    accountLoginExpiry.mockResolvedValue({ expiresAt: '2026-11-09T12:00:00.000Z', checkedAt: 'x' });
    const { result } = renderHook(() => useLoginExpiry(DIR));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(accountLoginExpiry).toHaveBeenCalledWith(DIR, false);
    expect(result.current.state).toMatchObject({ level: 'warning', relative: 'in 5 days' });
  });

  it('does nothing for a null config dir', () => {
    const { result } = renderHook(() => useLoginExpiry(null));
    expect(accountLoginExpiry).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });

  it('treats a failed read as unknown, not as an expiry', async () => {
    accountLoginExpiry.mockRejectedValue(new Error('rpc down'));
    const { result } = renderHook(() => useLoginExpiry(DIR));
    await waitFor(() => expect(accountLoginExpiry).toHaveBeenCalled());
    expect(result.current.state).toBeNull();
  });

  it('re-reads past the cache after this account is signed in', async () => {
    accountLoginExpiry
      .mockResolvedValueOnce({ expiresAt: '2026-11-05T00:00:00.000Z', checkedAt: 'x' })
      .mockResolvedValueOnce({ expiresAt: '2026-12-04T12:00:00.000Z', checkedAt: 'y' });
    const { result } = renderHook(() => useLoginExpiry(DIR));
    await waitFor(() => expect(result.current.state?.level).toBe('critical'));
    act(() => { announceAccountSignedIn('/some/other/dir'); });
    act(() => { announceAccountSignedIn(DIR); });
    await waitFor(() => expect(result.current.state?.level).toBe('ok'));
    expect(accountLoginExpiry).toHaveBeenCalledTimes(2);
    expect(accountLoginExpiry).toHaveBeenLastCalledWith(DIR, true);
  });

  it('refresh() asks past the cache', async () => {
    accountLoginExpiry.mockResolvedValue({ expiresAt: '2026-11-27T00:00:00.000Z', checkedAt: 'x' });
    const { result } = renderHook(() => useLoginExpiry(DIR));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(accountLoginExpiry).toHaveBeenLastCalledWith(DIR, true));
  });
});
