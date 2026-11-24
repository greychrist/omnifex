import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type IdentityVerdict } from "@/lib/api";

export interface AccountVerdictState {
  verdict: IdentityVerdict | null;
  /** False until the read settles; otherwise every mount flashes a status badge. */
  loaded: boolean;
  /** A failed IPC is not evidence about account state: show "couldn't verify", never "not signed in". */
  error: boolean;
  recheck: () => void;
}

/** The comparison lives in the daemon (`classifyIdentity`) so every surface shares one definition of "verified". */
type Snapshot = Omit<AccountVerdictState, "recheck">;

export function useAccountVerdict(configDir: string | null): AccountVerdictState {
  const [state, setState] = useState<Snapshot>({
    verdict: null,
    loaded: false,
    error: false,
  });
  const [nonce, setNonce] = useState(0);
  const configDirRef = useRef(configDir);
  useLayoutEffect(() => { configDirRef.current = configDir; });

  const recheck = useCallback(() => {
    if (configDirRef.current === null) return;
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (configDir === null) {
      setState({ verdict: null, loaded: false, error: false });
      return;
    }

    let cancelled = false;
    setState({ verdict: null, loaded: false, error: false });

    api
      .accountIdentityVerdict(configDir)
      .then((next) => {
        if (!cancelled) setState({ verdict: next, loaded: true, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ verdict: null, loaded: true, error: true });
      });

    return () => {
      cancelled = true;
    };
  }, [configDir, nonce]);

  useEffect(() => {
    if (configDir === null) return;
    return api.subscribeAccountIdentity(configDir, (verdict) => {
      setState({ verdict, loaded: true, error: false });
    });
  }, [configDir]);

  return { ...state, recheck };
}
