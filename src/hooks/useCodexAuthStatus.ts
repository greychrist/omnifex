import { useEffect, useState } from 'react';
import { api, type CodexAuthStatus } from '@/lib/api';

/**
 * Subscribe to Codex auth status for a single account's `configDir`, with an
 * initial snapshot. Returns `null` while the initial `getCodexAuthStatus` is
 * pending; flips to the real status once loaded and stays in sync via
 * `subscribeCodexAuthStatus`.
 *
 * Pass `configDir === null` to disable the hook entirely — it sets status to
 * `null` and performs no fetch or subscription. This lets callers gate it
 * conditionally (e.g. a Claude account has no Codex auth to watch).
 *
 * Used by the new-session form (to gate the submit button on Codex) and by
 * the AccountSettings Codex section (to render the right status row).
 * Subscribing once per consumer is fine — the main process broadcasts to
 * every renderer window and the subscription is just an event listener
 * filtered to the given configDir.
 */
export function useCodexAuthStatus(configDir: string | null): CodexAuthStatus | null {
  const [status, setStatus] = useState<CodexAuthStatus | null>(null);

  useEffect(() => {
    // Disabled: no configDir means there's nothing to watch. Reset to null so
    // a previous account's status doesn't linger after the caller disables.
    if (configDir === null) {
      setStatus(null);
      return;
    }

    let cancelled = false;

    // Initial snapshot — without this, the consumer would have to wait for
    // the next file-watcher fire (which only happens on a change) before
    // it knows whether the user is authenticated.
    api.getCodexAuthStatus(configDir)
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
      })
      .catch(() => {
        if (cancelled) return;
        // If the IPC fails, treat as unauthenticated rather than leaving
        // the consumer hanging on `null` forever. The next watcher fire
        // (or a manual sign-in attempt) will correct things.
        setStatus({ authenticated: false });
      });

    const unsub = api.subscribeCodexAuthStatus(configDir, (next) => {
      if (cancelled) return;
      setStatus(next);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [configDir]);

  return status;
}
