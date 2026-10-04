// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { sessionMcpServerStatus } = vi.hoisted(() => ({ sessionMcpServerStatus: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { sessionMcpServerStatus } }));

import { useSessionMcpStatus } from '../useSessionMcpStatus';

const list = [{ name: 'brain', status: 'connected', scope: 'user' }];

beforeEach(() => {
  sessionMcpServerStatus.mockReset().mockResolvedValue(list);
});

describe('useSessionMcpStatus', () => {
  it('asks for nothing until enabled', () => {
    const { result } = renderHook(() => useSessionMcpStatus('tab1', false));
    expect(sessionMcpServerStatus).not.toHaveBeenCalled();
    expect(result.current.servers).toBeNull();
  });

  it('loads once enabled', async () => {
    const { result } = renderHook(() => useSessionMcpStatus('tab1', true));
    await waitFor(() => { expect(result.current.servers).toEqual(list); });
    expect(sessionMcpServerStatus).toHaveBeenCalledWith('tab1');
  });

  // The CLI's control channel answers nothing until it has read its first
  // prompt, so an empty list right after Start is "not yet", not "none".
  it('keeps asking while the list is empty, then stops', async () => {
    sessionMcpServerStatus.mockResolvedValueOnce([]).mockResolvedValue(list);
    const { result } = renderHook(() => useSessionMcpStatus('tab1', true, 5));
    await waitFor(() => { expect(result.current.servers).toEqual(list); });
    const calls = sessionMcpServerStatus.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(sessionMcpServerStatus.mock.calls.length).toBe(calls);
  });

  it('asks again on refresh, showing loading meanwhile', async () => {
    const { result } = renderHook(() => useSessionMcpStatus('tab1', true));
    await waitFor(() => { expect(result.current.servers).toEqual(list); });
    act(() => { result.current.refresh(); });
    expect(result.current.servers).toBeNull();
    await waitFor(() => { expect(result.current.servers).toEqual(list); });
    expect(sessionMcpServerStatus).toHaveBeenCalledTimes(2);
  });

  it('reads a failed fetch as an empty list, not as loading forever', async () => {
    sessionMcpServerStatus.mockRejectedValue(new Error('x'));
    const { result } = renderHook(() => useSessionMcpStatus('tab1', true, 1000));
    await waitFor(() => { expect(result.current.servers).toEqual([]); });
  });
});
