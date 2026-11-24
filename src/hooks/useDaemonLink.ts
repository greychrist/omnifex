import { useEffect, useState } from 'react';
import type { LinkState } from '@/components/ChatStatusBar';

type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

/** Kept separate: the socket is shared by every tab, but the daemon fans a session out only to its subscribers. */
export function useDaemonLink(tabId: string, sessionId: string | null): LinkState {
  const remote = typeof window !== 'undefined' ? window.__omnifexRemote : undefined;
  const hasDaemon = !!remote?.client;

  const [connection, setConnection] = useState<ConnectionState | null>(
    () => (hasDaemon ? ((remote?.client?.state) ?? 'connecting') : null),
  );
  const [delivering, setDelivering] = useState(false);

  useEffect(() => {
    if (!hasDaemon) {
      setConnection(null);
      return;
    }
    setConnection((remote?.client?.state) ?? 'connecting');
    return window.electronAPI.onEvent('remote-connection', (p) => {
      setConnection((p as { state: ConnectionState }).state);
    });
  }, [hasDaemon, remote?.client]);

  useEffect(() => {
    if (!hasDaemon || !sessionId) {
      setDelivering(false);
      return;
    }
    // Seed from the shim: the subscription is established at boot, before any tab mounts.
    setDelivering(remote?.isSessionSubscribed?.(sessionId) ?? false);
    return window.electronAPI.onEvent(`remote-delivery:${tabId}`, (p) => {
      setDelivering((p as { subscribed: boolean }).subscribed);
    });
  }, [hasDaemon, remote, sessionId, tabId]);

  return { connection, delivering };
}
