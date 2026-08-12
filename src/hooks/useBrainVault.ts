import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type BrainVaultStatus } from '@/lib/api';

export interface UseBrainVault {
  accountId: number | null;
  setAccountId: (id: number) => void;
  status: BrainVaultStatus | null;
  notes: string[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  rebuild: () => Promise<void>;
  setVaultPath: (path: string) => Promise<void>;
  clearVaultPath: () => Promise<void>;
}

/**
 * One account's vault, and nothing else.
 *
 * The account is state, not a prop, because switching it must invalidate
 * everything derived from it in the same tick. Showing account 1's note list
 * under account 2's badge for even one frame is exactly the cross-account leak
 * the per-vault design exists to make impossible — so `status` and `notes` are
 * cleared synchronously on switch rather than replaced when the new load
 * resolves.
 */
export function useBrainVault(): UseBrainVault {
  const [accountId, setAccountIdState] = useState<number | null>(null);
  const [status, setStatus] = useState<BrainVaultStatus | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Guards against a slow load for a previous account overwriting a newer one.
   * Without it, switching quickly can land account 1's notes in account 2's
   * pane — the same leak the synchronous clear prevents, arriving late.
   */
  const loadToken = useRef(0);

  const load = useCallback(async (id: number): Promise<void> => {
    const token = ++loadToken.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.brainStatus(id);
      if (loadToken.current !== token) return;
      setStatus(next);
      // An unconfigured or missing vault has nothing to list, and asking would
      // make the registry lazily CREATE one — the opposite of what a status
      // screen should do.
      const list = next.configured && next.exists ? await api.brainListNotes(id) : [];
      if (loadToken.current !== token) return;
      setNotes(list);
    } catch (err) {
      if (loadToken.current !== token) return;
      setError((err as Error).message);
      setStatus(null);
      setNotes([]);
    } finally {
      if (loadToken.current === token) setLoading(false);
    }
  }, []);

  const setAccountId = useCallback((id: number): void => {
    setAccountIdState((current) => {
      if (current === id) return current;
      // Synchronous invalidation — see the hook doc above.
      loadToken.current++;
      setStatus(null);
      setNotes([]);
      setError(null);
      return id;
    });
  }, []);

  useEffect(() => {
    if (accountId === null) return;
    void load(accountId);
  }, [accountId, load]);

  const refresh = useCallback(async (): Promise<void> => {
    if (accountId !== null) await load(accountId);
  }, [accountId, load]);

  /** Runs an action, then reloads. A rejection becomes visible error state
   *  rather than an unhandled rejection the user never sees. */
  const act = useCallback(
    async (fn: (id: number) => Promise<unknown>): Promise<void> => {
      if (accountId === null) return;
      try {
        await fn(accountId);
      } catch (err) {
        setError((err as Error).message);
        return;
      }
      await load(accountId);
    },
    [accountId, load],
  );

  const rebuild = useCallback(
    (): Promise<void> => act((id) => api.brainRebuild(id)),
    [act],
  );

  const setVaultPath = useCallback(
    (path: string): Promise<void> => act((id) => api.brainSetVaultPath(id, path)),
    [act],
  );

  const clearVaultPath = useCallback(
    (): Promise<void> => act((id) => api.brainClearVaultPath(id)),
    [act],
  );

  return {
    accountId, setAccountId, status, notes, loading, error,
    refresh, rebuild, setVaultPath, clearVaultPath,
  };
}
