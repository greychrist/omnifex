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
import { Bell, RefreshCw, WifiOff, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { enablePush, pushSupport, type PushSupport } from '@/lib/remote/push';

const PUSH_DISMISSED_KEY = 'omnifex.remote.pushDismissed';

/**
 * One-line offer to turn on Web Push, shown on the web client only while it
 * is still possible and not yet decided: a secure origin, permission not yet
 * asked, and the user has not dismissed it. Electron has native banners and
 * never shows this.
 */
export function PushEnableBar(): React.JSX.Element | null {
  const [support, setSupport] = useState<PushSupport>(() => pushSupport());
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(PUSH_DISMISSED_KEY) === '1'; } catch { return false; }
  });
  const [busy, setBusy] = useState(false);

  const isWeb = typeof window !== 'undefined' && window.__omnifexRemote?.mode === 'web';
  if (!isWeb || dismissed || support !== 'default') return null;

  const enable = async () => {
    setBusy(true);
    try {
      setSupport(await enablePush());
    } catch (err) {
      console.warn('[remote] enabling push failed:', err);
      setSupport(pushSupport());
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(PUSH_DISMISSED_KEY, '1'); } catch { /* fine */ }
  };

  return (
    <div className="flex items-center justify-center gap-3 px-3 py-1.5 text-xs border-b bg-primary/5 border-primary/15 text-foreground">
      <Bell className="h-3.5 w-3.5 text-primary" />
      <span>Get notified when a session needs permission or finishes.</span>
      <button
        type="button"
        onClick={() => { void enable(); }}
        disabled={busy}
        className="rounded-md bg-primary text-primary-foreground px-2.5 py-1 font-medium disabled:opacity-60"
      >
        {busy ? 'Enabling…' : 'Enable notifications'}
      </button>
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

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
