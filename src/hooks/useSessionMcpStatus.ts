import { useCallback, useEffect, useState } from 'react';
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
 */
export function useSessionMcpStatus(
  tabId: string,
  enabled: boolean,
  pollMs = 2000,
): { servers: SessionMcpServerStatus[] | null; refresh: () => void } {
  const [servers, setServers] = useState<SessionMcpServerStatus[] | null>(null);
  const [generation, setGeneration] = useState(0);

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

  return { servers, refresh };
}
