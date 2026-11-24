import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { onAccountSignedIn } from "@/lib/accountSignIn";
import { loginExpiryState, type LoginExpiryState } from "@/lib/loginExpiry";

const TICK_MS = 60 * 60 * 1000;

export interface LoginExpiryHook {
  /** Null when unknown or nothing to say (no end, read failed). */
  state: LoginExpiryState | null;
  refresh: () => void;
}

export function useLoginExpiry(configDir: string | null): LoginExpiryHook {
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [request, setRequest] = useState({ n: 0, fresh: false });
  const dirRef = useRef(configDir);
  useLayoutEffect(() => { dirRef.current = configDir; });

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
        // An unreadable expiry is unknown, not expired.
        if (!cancelled) setExpiresAt(null);
      });
    return () => { cancelled = true; };
  }, [configDir, request]);

  useEffect(() => {
    if (configDir === null) return;
    const id = setInterval(() => { setRequest((r) => ({ n: r.n + 1, fresh: false })); }, TICK_MS);
    return () => { clearInterval(id); };
  }, [configDir]);

  useEffect(() => {
    if (configDir === null) return;
    const offSignIn = onAccountSignedIn((dir) => { if (dir === configDir) refresh(); });
    const offIdentity = api.subscribeAccountIdentity(configDir, () => { refresh(); });
    return () => { offSignIn(); offIdentity(); };
  }, [configDir, refresh]);

  return { state: configDir === null ? null : loginExpiryState(expiresAt, now), refresh };
}
