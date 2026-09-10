/**
 * What the socket to the daemon is doing, when that is worth a line.
 *
 * Silent while connected. "Reconnecting…" while the client is between
 * sockets — an iPad coming back from the background lands here for a second
 * or two — and a brief "caught up N events" once the resubscribe has replayed
 * what was missed, so a wall of new transcript rows reads as a catch-up and
 * not as a glitch. Renders nothing at all under legacy Electron IPC, where
 * there is no socket to report on.
 */
import { useEffect, useState } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';

import { cn } from '@/lib/utils';

type State = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export function RemoteConnectionBanner(): React.JSX.Element | null {
  const remote = typeof window !== 'undefined' ? window.__omnifexRemote : undefined;
  const [state, setState] = useState<State>((remote?.client?.state as State | undefined) ?? 'connected');
  const [everConnected, setEverConnected] = useState(remote?.client?.state === 'connected');

  useEffect(() => {
    if (!remote?.client) return;
    return window.electronAPI.onEvent('remote-connection', (p) => {
      const next = (p as { state: State }).state;
      setState(next);
      if (next === 'connected') setEverConnected(true);
    });
  }, [remote?.client]);

  if (!remote?.client) return null;
  if (state === 'connected') return null;

  const reconnecting = state === 'reconnecting' || (state === 'connecting' && everConnected);
  return (
    <div
      role="status"
      className={cn(
        'flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium border-b',
        reconnecting ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : 'bg-destructive/10 text-destructive border-destructive/20',
      )}
    >
      {reconnecting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <WifiOff className="h-3.5 w-3.5" />}
      {reconnecting ? 'Reconnecting to OmniFex…' : state === 'connecting' ? 'Connecting to OmniFex…' : 'Disconnected from OmniFex'}
    </div>
  );
}

/**
 * Per-session "caught up" pill. Mounted inside a session; listens for the
 * shim's `remote-caught-up:<tabId>` and shows for a few seconds.
 */
export function CaughtUpPill({ tabId }: { tabId: string }): React.JSX.Element | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!window.__omnifexRemote?.client) return;
    return window.electronAPI.onEvent(`remote-caught-up:${tabId}`, (p) => {
      const n = (p as { events?: number }).events ?? 0;
      if (n <= 0) return;
      setCount(n);
    });
  }, [tabId]);

  useEffect(() => {
    if (count === null) return;
    const t = setTimeout(() => setCount(null), 4000);
    return () => clearTimeout(t);
  }, [count]);

  if (count === null) return null;
  return (
    <div className="flex justify-center pointer-events-none">
      <div className="mt-1 rounded-full bg-primary/10 text-primary text-[11px] px-3 py-1 shadow-sm">
        Caught up {count} {count === 1 ? 'event' : 'events'}
      </div>
    </div>
  );
}
