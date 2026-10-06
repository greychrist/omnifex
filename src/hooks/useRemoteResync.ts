import { useEffect, useRef } from 'react';

/**
 * Reload a tab's transcript when the remote shim says it missed events the
 * daemon can no longer replay.
 *
 * The daemon keeps events in memory only. A reconnect that fell further
 * behind than its ring, or one that spans a daemon restart, cannot be caught
 * up from there; the shim announces `remote-resync:<tabId>` instead, and the
 * transcript is reloaded from the CLI's JSONL — the same read a page load
 * does. Turn state is not part of this: it arrives as `session.state` from
 * the daemon and is never inferred from the transcript.
 *
 * `remote-resync:` exists only on the shim; the preload bridge throws on
 * unknown channels, hence the mode guard.
 */
export function useRemoteResync(tabId: string, reload: () => void): void {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!window.__omnifexRemote?.client) return;
    return window.electronAPI.onEvent(`remote-resync:${tabId}`, () => {
      reloadRef.current();
    });
  }, [tabId]);
}
