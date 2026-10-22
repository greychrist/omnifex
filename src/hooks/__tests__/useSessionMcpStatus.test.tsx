// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('useSessionMcpStatus watchUntil', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('watchUntil resolves true once the server leaves needs-auth', async () => {
    vi.useFakeTimers();
    const needsAuth = [{ name: 'atlassian', status: 'needs-auth', scope: 'claudeai' }];
    const connected = [{ name: 'atlassian', status: 'connected', scope: 'claudeai' }];
    sessionMcpServerStatus
      .mockResolvedValueOnce(needsAuth)
      .mockResolvedValueOnce(needsAuth)
      .mockResolvedValue(connected);
    const { result } = renderHook(() => useSessionMcpStatus('tab1', false, 1000));
    let outcome: boolean | undefined;
    act(() => {
      void result.current
        .watchUntil('atlassian', (s) => s?.status === 'connected')
        .then((v) => { outcome = v; });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(outcome).toBe(true);
    expect(result.current.servers).toEqual(connected);
    const calls = sessionMcpServerStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(sessionMcpServerStatus.mock.calls.length).toBe(calls);
  });

  it('watchUntil resolves false after timeoutMs', async () => {
    vi.useFakeTimers();
    sessionMcpServerStatus.mockResolvedValue([{ name: 'atlassian', status: 'needs-auth', scope: 'claudeai' }]);
    const { result } = renderHook(() => useSessionMcpStatus('tab1', false, 1000));
    let outcome: boolean | undefined;
    act(() => {
      void result.current
        .watchUntil('atlassian', (s) => s?.status === 'connected', 5000)
        .then((v) => { outcome = v; });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
    expect(outcome).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(outcome).toBe(false);
    const calls = sessionMcpServerStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(sessionMcpServerStatus.mock.calls.length).toBe(calls);
  });

  it('watchUntil resolves false and stops polling on unmount', async () => {
    vi.useFakeTimers();
    sessionMcpServerStatus.mockResolvedValue([{ name: 'atlassian', status: 'needs-auth', scope: 'claudeai' }]);
    const { result, unmount } = renderHook(() => useSessionMcpStatus('tab1', false, 1000));
    let outcome: boolean | undefined;
    act(() => {
      void result.current
        .watchUntil('atlassian', (s) => s?.status === 'connected')
        .then((v) => { outcome = v; });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    unmount();
    const calls = sessionMcpServerStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(outcome).toBe(false);
    expect(sessionMcpServerStatus.mock.calls.length).toBe(calls);
  });

  // The main process answers [] on its 3 s timeout, control errors, or a
  // non-live engine: that is "no answer this tick", not "no servers".
  it('an empty tick between two real answers neither blanks servers nor resolves the watch', async () => {
    vi.useFakeTimers();
    const disabled = [{ name: 'gh', status: 'disabled', scope: 'user' }];
    const pending = [{ name: 'gh', status: 'pending', scope: 'user' }];
    sessionMcpServerStatus
      .mockResolvedValueOnce(disabled)
      .mockResolvedValueOnce([])
      .mockResolvedValue(pending);
    const done = vi.fn((s?: { status: string }) => s !== undefined && s.status !== 'disabled');
    const { result } = renderHook(() => useSessionMcpStatus('tab1', false, 1000));
    let outcome: boolean | undefined;
    act(() => {
      void result.current.watchUntil('gh', done).then((v) => { outcome = v; });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.servers).toEqual(disabled);
    expect(outcome).toBeUndefined();
    expect(done).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(outcome).toBe(true);
    expect(result.current.servers).toEqual(pending);
  });
});
