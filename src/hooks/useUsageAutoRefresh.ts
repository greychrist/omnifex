import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type UsageRunResult } from '@/lib/api';

const REFRESH_MS = 5 * 60_000;
const STALE_MS = 5 * 60_000;

export interface UseUsageAutoRefreshResult {
  data: UsageRunResult | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Drives the live `/usage` widget data for a single active account.
 *
 * - On mount: reads the cached result from the main process. If absent or
 *   stale (> 5 min), fires a fresh `runUsageCli` immediately.
 * - While the tab is visible: re-runs every 5 minutes.
 * - On `visibilitychange` to hidden: pauses the timer.
 * - On return to visible: catches up if at least one interval elapsed
 *   while hidden, then resumes the timer.
 *
 * The main-process `usage-runner` service de-dups concurrent calls per
 * account, so multiple subscribers (e.g. several open tabs on the same
 * account) collapse onto a single PTY spawn.
 */
export function useUsageAutoRefresh(accountName: string | null): UseUsageAutoRefreshResult {
  const [data, setData] = useState<UsageRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const lastRunAt = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doRun = useCallback(async () => {
    if (!accountName) return;
    setLoading(true);
    try {
      const r = await api.runUsageCli(accountName);
      lastRunAt.current = Date.now();
      setData(r);
    } catch (err) {
      console.error('[useUsageAutoRefresh] runUsageCli failed', err);
    } finally {
      setLoading(false);
    }
  }, [accountName]);

  // Initial fetch (read cache, then refresh if missing/stale)
  useEffect(() => {
    let cancelled = false;
    if (!accountName) {
      setData(null);
      return;
    }
    (async () => {
      try {
        const cached = await api.getLastUsageCli(accountName);
        if (cancelled) return;
        if (cached) {
          setData(cached);
          lastRunAt.current = cached.observed_at;
        }
        const stale = !cached || Date.now() - cached.observed_at > STALE_MS;
        if (stale) await doRun();
      } catch (err) {
        if (!cancelled) console.error('[useUsageAutoRefresh] initial fetch failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountName, doRun]);

  // Visibility-aware periodic timer
  useEffect(() => {
    if (!accountName) return;

    const start = (): void => {
      if (intervalRef.current) return;
      intervalRef.current = setInterval(() => {
        if (document.visibilityState === 'visible') {
          void doRun();
        }
      }, REFRESH_MS);
    };
    const stop = (): void => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
    const onVis = (): void => {
      if (document.visibilityState === 'visible') {
        if (Date.now() - lastRunAt.current >= REFRESH_MS) void doRun();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
  }, [accountName, doRun]);

  return { data, loading, refresh: doRun };
}
