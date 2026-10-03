// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { sessionPlugins } = vi.hoisted(() => ({ sessionPlugins: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { sessionPlugins } }));

import { useSessionPlugins } from '../useSessionPlugins';

const list = [{ name: 'superpowers', path: '/p', scope: 'user', mod: null }];

beforeEach(() => {
  sessionPlugins.mockReset().mockResolvedValue(list);
});

describe('useSessionPlugins', () => {
  // Before system:init, main can only answer with reload_plugins, which
  // re-runs every mod's session.start. So nothing is asked until the
  // session has an init, or the panel that needs the list is open.
  it('asks for nothing until enabled', () => {
    const { result } = renderHook(() => useSessionPlugins('tab1', 'a', false));
    expect(sessionPlugins).not.toHaveBeenCalled();
    expect(result.current.plugins).toBeNull();
  });

  it('loads without forcing a reload', async () => {
    const { result } = renderHook(() => useSessionPlugins('tab1', 'a', true));
    await waitFor(() => { expect(result.current.plugins).toEqual(list); });
    expect(sessionPlugins).toHaveBeenCalledWith('tab1', false);
  });

  // A restart is a new process with a new plugin list.
  it('loads again when the reload key changes', async () => {
    const { rerender } = renderHook(({ k }) => useSessionPlugins('tab1', k, true), { initialProps: { k: 'a' } });
    await waitFor(() => { expect(sessionPlugins).toHaveBeenCalledTimes(1); });
    rerender({ k: 'b' });
    await waitFor(() => { expect(sessionPlugins).toHaveBeenCalledTimes(2); });
  });

  it('forces a reload on refresh, showing loading meanwhile', async () => {
    const { result } = renderHook(() => useSessionPlugins('tab1', 'a', true));
    await waitFor(() => { expect(result.current.plugins).toEqual(list); });
    act(() => { result.current.refresh(); });
    expect(result.current.plugins).toBeNull();
    await waitFor(() => { expect(result.current.plugins).toEqual(list); });
    expect(sessionPlugins).toHaveBeenLastCalledWith('tab1', true);
  });

  it('reads a failed fetch as an empty list, not as loading forever', async () => {
    sessionPlugins.mockRejectedValue(new Error('x'));
    const { result } = renderHook(() => useSessionPlugins('tab1', 'a', true));
    await waitFor(() => { expect(result.current.plugins).toEqual([]); });
  });
});
