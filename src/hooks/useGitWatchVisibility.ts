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
 */
export function useGitWatchVisibility(watchId: string | null, isActive: boolean): void {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden');
  const [awake, setAwake] = useState(true);
  const reported = useRef<{ watchId: string; visible: boolean } | null>(null);

  useEffect(() => {
    const onChange = () => { setDocumentVisible(document.visibilityState !== 'hidden'); };
    document.addEventListener('visibilitychange', onChange);
    const unlisten = window.electronAPI.onEvent(POWER_STATE_CHANNEL, (payload: unknown) => {
      setAwake((payload as PowerState | null)?.awake !== false);
    });
    return () => {
      document.removeEventListener('visibilitychange', onChange);
      unlisten();
    };
  }, []);

  const visible = isActive && documentVisible && awake;
  useEffect(() => {
    if (!watchId) return;
    const last = reported.current;
    if (last?.watchId === watchId && last.visible === visible) return;
    reported.current = { watchId, visible };
    void api.setSessionGitWatchVisible(watchId, visible).catch(() => { /* the watcher keeps its last state */ });
  }, [watchId, visible]);
}
