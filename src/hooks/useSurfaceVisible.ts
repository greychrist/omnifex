import { useEffect, useState } from 'react';
import { POWER_STATE_CHANNEL, type PowerState } from '@/lib/powerState';

/**
 * Whether anyone can see a tab's surface: the tab is the active one, its
 * document is visible (not minimised, hidden or occluded) and the machine is
 * awake (main's powerMonitor — a locked screen does not reliably hide the
 * document). Every tab stays mounted, so anything that polls the main process
 * or the daemon gates on this; without it each tab polled forever.
 */
export function useSurfaceVisible(isActive: boolean): boolean {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden');
  const [awake, setAwake] = useState(true);

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

  return isActive && documentVisible && awake;
}
