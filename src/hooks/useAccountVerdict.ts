import { useCallback, useEffect, useRef, useState } from "react";
import { api, type IdentityVerdict } from "@/lib/api";

export interface AccountVerdictState {
  verdict: IdentityVerdict | null;
  /**
   * False until the read settles. Load-bearing, not decoration: without it,
   * the pre-resolution state is indistinguishable from a real verdict, so
   * every mount would flash a status badge before the read completes.
   */
  loaded: boolean;
  /**
   * True when the read itself failed. Kept separate from any verdict value
   * because a failed IPC is NOT evidence about account state — reporting
   * "not signed in" here would be a false claim. Surface as "couldn't verify".
   */
  error: boolean;
  /**
   * Force a fresh check now. Use for an explicit "re-check" affordance — the
   * watcher covers the passive case, this covers "I just fixed it and want to
   * confirm without waiting".
   */
  recheck: () => void;
}

/**
 * Whether a config dir is signed in as the account that owns it.
 *
 * Pass `null` to disable — callers do that where there is nothing to check,
 * so those surfaces cost zero IPC round-trips.
 *
 * The comparison lives in the main process (`classifyIdentity`), not here:
 * one definition of "verified", shared by the session pre-flight check, the
 * Settings row, and the session badge. This hook only transports the answer.
 */
type Snapshot = Omit<AccountVerdictState, "recheck">;

export function useAccountVerdict(configDir: string | null): AccountVerdictState {
  const [state, setState] = useState<Snapshot>({
    verdict: null,
    loaded: false,
    error: false,
  });
  // Bumping this re-runs the fetch effect. Cheaper than duplicating the fetch
  // logic in a separate callback, and keeps cancellation in one place.
  const [nonce, setNonce] = useState(0);
  // Ref indirection so `recheck` stays referentially stable — callers pass it
  // to onClick without re-triggering their own effects.
  const configDirRef = useRef(configDir);
  configDirRef.current = configDir;

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

  // Self-correct when the signed-in account changes on disk, so a logout/login
  // performed outside OmniFex doesn't leave a stale verdict on screen.
  useEffect(() => {
    if (configDir === null) return;
    return api.subscribeAccountIdentity(configDir, (verdict) => {
      setState({ verdict, loaded: true, error: false });
    });
  }, [configDir]);

  return { ...state, recheck };
}
