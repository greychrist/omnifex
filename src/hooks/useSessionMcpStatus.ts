import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SessionMcpServerStatus } from '@/lib/api';
import { logAndForget } from '@/lib/fireAndLog';

/**
 * The session's MCP servers as the CLI reports them now — what the Session
 * context panel lists and what its MCP heading counts.
 *
 * It used to be fetched inside the list, which mounts only with its section
 * open, so the heading had to count from `system:init` instead. A session
 * opened from its transcript has no init, and the heading showed no count at
 * all while Mods and Plugins did. Same shape as useSessionPlugins.
 *
 * While enabled and the list is empty it asks again every `pollMs`: the CLI's
 * control channel answers nothing until it has read its first prompt, so an
 * empty list right after Start means "not yet". It stops at the first
 * non-empty answer, on disable, and on unmount.
 *
 * `watchUntil` is a second, independent loop for a row action (Authenticate,
 * Disable, ...): it polls the same status every `pollMs`, writes `servers` on
 * each tick, and resolves true once `done` holds for the named server, false
 * at `timeoutMs` or unmount. It never touches the initial-load loop above.
 */
export type McpWatchUntil = (
  serverName: string,
  done: (server: SessionMcpServerStatus | undefined) => boolean,
  timeoutMs?: number,
) => Promise<boolean>;

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
        setServers(result);
        if (done(result.find((s) => s.name === serverName))) return true;
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
