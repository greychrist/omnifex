import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { onAccountSignedIn } from "@/lib/accountSignIn";
import { loginExpiryState, type LoginExpiryState } from "@/lib/loginExpiry";

/** Re-read and re-grade this often, so "in 3 days" ages while a tab stays open. */
const TICK_MS = 60 * 60 * 1000;

export interface LoginExpiryHook {
  /** Null until known, and whenever there is nothing to say (no end, read failed). */
  state: LoginExpiryState | null;
  /** Ask the CLI again, past the daemon's cache. */
  refresh: () => void;
}

/**
 * When `configDir`'s stored claude.ai sign-in ends. Pass null to disable
 * (Codex accounts, no config dir). The daemon caches the CLI's answer, so
 * every surface that wants it may call this.
 */
export function useLoginExpiry(configDir: string | null): LoginExpiryHook {
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // `fresh` makes the next fetch bypass the daemon cache.
  const [request, setRequest] = useState({ n: 0, fresh: false });
  const dirRef = useRef(configDir);
  dirRef.current = configDir;

  const refresh = useCallback(() => {
    if (dirRef.current === null) return;
    setRequest((r) => ({ n: r.n + 1, fresh: true }));
  }, []);

  useEffect(() => {
    setExpiresAt(null);
  }, [configDir]);

  useEffect(() => {
    if (configDir === null) return;
    let cancelled = false;
    api
      .accountLoginExpiry(configDir, request.fresh)
      .then((r) => {
        if (cancelled) return;
        setExpiresAt(r?.expiresAt ?? null);
        setNow(Date.now());
      })
      .catch(() => {
        // An unreadable expiry is unknown, not expired: say nothing.
        if (!cancelled) setExpiresAt(null);
      });
    return () => { cancelled = true; };
  }, [configDir, request]);

  useEffect(() => {
    if (configDir === null) return;
    const id = setInterval(() => { setRequest((r) => ({ n: r.n + 1, fresh: false })); }, TICK_MS);
    return () => { clearInterval(id); };
  }, [configDir]);

  // A sign-in moves the date: one done here (announced by the popover) or
  // one that changes who is signed in on disk (the daemon's watcher).
  useEffect(() => {
    if (configDir === null) return;
    const offSignIn = onAccountSignedIn((dir) => { if (dir === configDir) refresh(); });
    const offIdentity = api.subscribeAccountIdentity(configDir, () => { refresh(); });
    return () => { offSignIn(); offIdentity(); };
  }, [configDir, refresh]);

  return { state: configDir === null ? null : loginExpiryState(expiresAt, now), refresh };
}
