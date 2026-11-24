import { useEffect, useState } from 'react';
import { POWER_STATE_CHANNEL, type PowerState } from '@/lib/powerState';

/** Every tab stays mounted, so polling gates on this. Power state comes from main: a locked screen does not reliably hide the document. */
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
