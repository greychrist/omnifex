// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useRemoteResync } from '../useRemoteResync';

type Listener = (payload: unknown) => void;

function installShim(remote: boolean) {
  const listeners = new Map<string, Set<Listener>>();
  (window as unknown as { __omnifexRemote?: unknown }).__omnifexRemote = remote ? { client: {} } : undefined;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onEvent: vi.fn((channel: string, cb: Listener) => {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    }),
  };
  return {
    emit: (channel: string, payload: unknown) => {
      for (const cb of listeners.get(channel) ?? []) cb(payload);
    },
    count: (channel: string) => listeners.get(channel)?.size ?? 0,
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { __omnifexRemote?: unknown }).__omnifexRemote;
});

describe('useRemoteResync', () => {
  it('reloads when the shim says this tab missed events the daemon no longer has', () => {
    const shim = installShim(true);
    const reload = vi.fn();
    renderHook(() => useRemoteResync('tab-A', reload));

    shim.emit('remote-resync:tab-A', { sessionId: 'sid-1' });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores another tab\'s resync', () => {
    const shim = installShim(true);
    const reload = vi.fn();
    renderHook(() => useRemoteResync('tab-A', reload));

    shim.emit('remote-resync:tab-B', { sessionId: 'sid-2' });

    expect(reload).not.toHaveBeenCalled();
  });

  it('calls the latest reload without resubscribing when it changes', () => {
    // AgentSession's reload closes over per-render state; a stale one would
    // load the wrong session's transcript.
    const shim = installShim(true);
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useRemoteResync('tab-A', cb), { initialProps: { cb: first } });
    rerender({ cb: second });

    shim.emit('remote-resync:tab-A', {});

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(shim.count('remote-resync:tab-A')).toBe(1);
  });

  it('does not listen in legacy IPC mode, where the preload throws on unknown channels', () => {
    installShim(false);
    renderHook(() => useRemoteResync('tab-A', vi.fn()));
    expect(window.electronAPI.onEvent).not.toHaveBeenCalled();
  });
});
