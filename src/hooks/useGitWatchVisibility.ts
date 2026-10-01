import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useSurfaceVisible } from './useSurfaceVisible';

/**
 * Tell the git watcher whether anyone can see this watch's badges (see
 * useSurfaceVisible). The watcher polls a repository only while at least one
 * of its watches is visible.
 *
 * In remote mode the daemon hides a watch when the connection holding it
 * closes (a closed window must not poll), so each reconnect reports again.
 */
export function useGitWatchVisibility(watchId: string | null, isActive: boolean): void {
  const visible = useSurfaceVisible(isActive);
  const [connectedCount, setConnectedCount] = useState(0);
  const reported = useRef<{ watchId: string; visible: boolean; connectedCount: number } | null>(null);

  useEffect(() => {
    return window.electronAPI.onEvent('remote-connection', (payload: unknown) => {
      if ((payload as { state?: string } | null)?.state === 'connected') setConnectedCount((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    if (!watchId) return;
    const last = reported.current;
    if (last?.watchId === watchId && last.visible === visible && last.connectedCount === connectedCount) return;
    reported.current = { watchId, visible, connectedCount };
    void api.setSessionGitWatchVisible(watchId, visible).catch(() => { /* the watcher keeps its last state */ });
  }, [watchId, visible, connectedCount]);
}
