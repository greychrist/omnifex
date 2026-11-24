import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type BrainNoteMeta, type BrainVaultStatus } from '@/lib/api';

export interface UseBrainVault {
  accountId: number | null;
  setAccountId: (id: number) => void;
  status: BrainVaultStatus | null;
  notes: BrainNoteMeta[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  rebuild: () => Promise<void>;
  setVaultPath: (path: string) => Promise<void>;
  clearVaultPath: () => Promise<void>;
}

/** The account is state so a switch clears `status` and `notes` synchronously: one frame of the old list is a cross-account leak. */
export function useBrainVault(): UseBrainVault {
  const [accountId, setAccountIdState] = useState<number | null>(null);
  const [status, setStatus] = useState<BrainVaultStatus | null>(null);
  const [notes, setNotes] = useState<BrainNoteMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** A slow load for a previous account must not overwrite a newer one. */
  const loadToken = useRef(0);

  const load = useCallback(async (id: number): Promise<void> => {
    const token = ++loadToken.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.brainStatus(id);
      if (loadToken.current !== token) return;
      setStatus(next);
      // Asking for an unconfigured vault's list would lazily create one.
      const list = next.configured && next.exists ? await api.brainListNoteMeta(id) : [];
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
