import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SessionMcpServerStatus } from '@/lib/api';
import { logAndForget } from '@/lib/fireAndLog';

export type McpWatchUntil = (
  serverName: string,
  done: (server: SessionMcpServerStatus | undefined) => boolean,
  timeoutMs?: number,
) => Promise<boolean>;

/**
 * Polls while the list is empty: the CLI's control channel answers nothing until it has read its first
 * prompt, so empty right after Start means "not yet".
 */
export function useSessionMcpStatus(
  tabId: string,
  enabled: boolean,
  pollMs = 2000,
): { servers: SessionMcpServerStatus[] | null; refresh: () => void; watchUntil: McpWatchUntil } {
  const [servers, setServers] = useState<SessionMcpServerStatus[] | null>(null);
  const [generation, setGeneration] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const result = (await api.sessionMcpServerStatus(tabId)) ?? [];
      setServers(result);
      return result.length > 0;
    } catch (err) {
      console.error('[useSessionMcpStatus] failed to load MCP server status:', err);
      setServers([]);
      return false;
    }
  }, [tabId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    logAndForget('session-mcpstatus:poll', (async () => {
      while (!cancelled) {
        const ok = await load();
        if (ok || cancelled) return;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    })());
    return () => { cancelled = true; };
  }, [enabled, load, pollMs, generation]);

  const refresh = useCallback(() => {
    setServers(null);
    setGeneration((g) => g + 1);
  }, []);

  const watchUntil = useCallback<McpWatchUntil>(async (serverName, done, timeoutMs = 180_000) => {
    const deadline = Date.now() + timeoutMs;
    while (mountedRef.current) {
      try {
        const result = (await api.sessionMcpServerStatus(tabId)) ?? [];
        if (!mountedRef.current) return false;
        // [] means no answer this tick (timeout, control error, engine not live), not "none".
        if (result.length > 0) {
          // Keep the reference so a long watch does not re-render the tab every tick.
          setServers((prev) => (prev !== null && JSON.stringify(prev) === JSON.stringify(result) ? prev : result));
          if (done(result.find((s) => s.name === serverName))) return true;
        }
      } catch (err) {
        console.error('[useSessionMcpStatus] watch poll failed:', err);
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
    return false;
  }, [tabId, pollMs]);

  return { servers, refresh, watchUntil };
}
