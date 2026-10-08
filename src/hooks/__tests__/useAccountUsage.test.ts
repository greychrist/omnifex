// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { autoRefresh, sessionCost } = vi.hoisted(() => ({
  autoRefresh: vi.fn(),
  sessionCost: vi.fn(),
}));
vi.mock('@/hooks/useUsageAutoRefresh', () => ({ useUsageAutoRefresh: autoRefresh }));
vi.mock('@/hooks/useSessionCost', () => ({ useSessionCost: sessionCost }));

import { useAccountUsage } from '../useAccountUsage';

const refresh = vi.fn(async () => {});

beforeEach(() => {
  autoRefresh.mockReset().mockReturnValue({ data: null, loading: true, refresh });
  sessionCost.mockReset().mockReturnValue(null);
});

const args = {
  accountName: 'Work',
  hasCost: true,
  sessionActive: true,
  configDir: '/c',
  projectPath: '/p',
  sessionId: 's1',
};

describe('useAccountUsage', () => {
  it('passes the account and session state to the /usage refresher', () => {
    const { result } = renderHook(() => useAccountUsage(args));
    expect(autoRefresh).toHaveBeenCalledWith('Work', true);
    expect(result.current.loading).toBe(true);
    expect(result.current.refresh).toBe(refresh);
  });

  // The watcher also feeds the per-agent stats in the `agents` popover, which
  // every account shows. Only the account widget's dollar figure is gated.
  it('watches cost for every account, but reports it only for a cost-based one', () => {
    const snap = { totalUsd: 1.5, bySubagent: { a1: { usd: 0.2 } } };
    sessionCost.mockReturnValue(snap);
    const { result } = renderHook(() => useAccountUsage({ ...args, hasCost: false }));
    expect(sessionCost).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
    expect(result.current.sessionCost).toBeNull();
    expect(result.current.subagentCost).toBe(snap.bySubagent);
  });

  it('returns the computed cost of a cost-based account', () => {
    const snap = { totalUsd: 1.5 };
    sessionCost.mockReturnValue(snap);
    const { result } = renderHook(() => useAccountUsage(args));
    expect(sessionCost).toHaveBeenCalledWith({
      configDir: '/c', projectPath: '/p', sessionId: 's1', accountName: 'Work',
    });
    expect(result.current.sessionCost).toBe(snap);
  });
});
