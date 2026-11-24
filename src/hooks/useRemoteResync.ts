import { useEffect, useLayoutEffect, useRef } from 'react';

export function useRemoteResync(tabId: string, reload: () => void): void {
  const reloadRef = useRef(reload);
  useLayoutEffect(() => { reloadRef.current = reload; });

  useEffect(() => {
    if (!window.__omnifexRemote?.client) return;
    return window.electronAPI.onEvent(`remote-resync:${tabId}`, () => {
      reloadRef.current();
    });
  }, [tabId]);
}
