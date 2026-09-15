import { useEffect, useState } from 'react';
import type { LinkState } from '@/components/ChatStatusBar';

type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

/**
 * The two independent facts behind the chat status bar's link glyph.
 *
 * `connection` is global — there is one socket per client, shared by every
 * tab. `delivering` is not: the daemon fans a session out only to the clients
 * that subscribed to it, so a healthy socket says nothing about whether THIS
 * session's events are arriving. Keeping them separate is the whole point;
 * collapsing them is what would have shown green through the outage.
 *
 * `connection: null` means this page has no daemon at all (legacy IPC), which
 * the glyph renders as nothing rather than as a permanent failure.
 */
export function useDaemonLink(tabId: string, sessionId: string | null): LinkState {
  const remote = typeof window !== 'undefined' ? window.__omnifexRemote : undefined;
  const hasDaemon = !!remote?.client;

  const [connection, setConnection] = useState<ConnectionState | null>(
    () => (hasDaemon ? ((remote?.client?.state as ConnectionState | undefined) ?? 'connecting') : null),
  );
  const [delivering, setDelivering] = useState(false);

  useEffect(() => {
    if (!hasDaemon) {
      setConnection(null);
      return;
    }
    setConnection((remote?.client?.state as ConnectionState | undefined) ?? 'connecting');
    return window.electronAPI.onEvent('remote-connection', (p) => {
      setConnection((p as { state: ConnectionState }).state);
    });
  }, [hasDaemon, remote?.client]);

  useEffect(() => {
    if (!hasDaemon || !sessionId) {
      setDelivering(false);
      return;
    }
    // Seed from the shim rather than waiting for a change: the subscription
    // is normally established at boot, long before any tab mounts, so a tab
    // that only listened would show "not delivering" forever on a healthy
    // session.
    setDelivering(remote?.isSessionSubscribed?.(sessionId) ?? false);
    return window.electronAPI.onEvent(`remote-delivery:${tabId}`, (p) => {
      setDelivering((p as { subscribed: boolean }).subscribed);
    });
  }, [hasDaemon, remote, sessionId, tabId]);

  return { connection, delivering };
}
