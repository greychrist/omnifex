import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { POWER_STATE_CHANNEL, type PowerState } from '@/lib/powerState';

/**
 * Tell the git watcher whether anyone can see this watch's badges: the tab is
 * the active one, its document is visible (not minimised, hidden or occluded)
 * and the machine is awake (main's powerMonitor — a locked screen does not
 * reliably hide the document). The watcher polls a repository only while at
 * least one of its watches is visible; every tab stays mounted, so without
 * this each one polled forever.
 *
 * In remote mode the daemon hides a watch when the connection holding it
 * closes (a closed window must not poll), so each reconnect reports again.
 */
export function useGitWatchVisibility(watchId: string | null, isActive: boolean): void {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden');
  const [awake, setAwake] = useState(true);
  const [connectedCount, setConnectedCount] = useState(0);
  const reported = useRef<{ watchId: string; visible: boolean; connectedCount: number } | null>(null);

  useEffect(() => {
    const onChange = () => { setDocumentVisible(document.visibilityState !== 'hidden'); };
    document.addEventListener('visibilitychange', onChange);
    const unlisten = window.electronAPI.onEvent(POWER_STATE_CHANNEL, (payload: unknown) => {
      setAwake((payload as PowerState | null)?.awake !== false);
    });
    const unlistenLink = window.electronAPI.onEvent('remote-connection', (payload: unknown) => {
      if ((payload as { state?: string } | null)?.state === 'connected') setConnectedCount((n) => n + 1);
    });
    return () => {
      document.removeEventListener('visibilitychange', onChange);
      unlisten();
      unlistenLink();
    };
  }, []);

  const visible = isActive && documentVisible && awake;
  useEffect(() => {
    if (!watchId) return;
    const last = reported.current;
    if (last?.watchId === watchId && last.visible === visible && last.connectedCount === connectedCount) return;
    reported.current = { watchId, visible, connectedCount };
    void api.setSessionGitWatchVisible(watchId, visible).catch(() => { /* the watcher keeps its last state */ });
  }, [watchId, visible, connectedCount]);
}
