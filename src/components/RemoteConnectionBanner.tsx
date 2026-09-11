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
import { useCallback, useEffect, useState } from 'react';
import { Bell, Laptop, RefreshCw, WifiOff, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { enablePush, pushSupport, type PushSupport } from '@/lib/remote/push';
import { clearLocalMode, forceLocalMode, forcedDaemonUrl } from '@/lib/remote/localMode';
import { daemonHealthUrl, fetchDaemonHealth, type DaemonHealthInfo } from '@/lib/remote/daemonStatus';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * How long an outage has to last before the app offers a way out of it.
 *
 * Past several reconnect attempts, and well past a daemon restart — the title
 * bar's own Restart button heals in two or three seconds. An offer any earlier
 * would ask the user to give up the view of their live sessions over a blip
 * that was about to fix itself.
 */
const OFFER_AFTER_MS = 20_000;

/** How often local mode asks whether the daemon is back. */
const PROBE_EVERY_MS = 5_000;

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

export function RemoteConnectionBanner({
  reload = () => { window.location.reload(); },
}: { reload?: () => void } = {}): React.JSX.Element | null {
  const remote = typeof window !== 'undefined' ? window.__omnifexRemote : undefined;
  const [state, setState] = useState<State>((remote?.client?.state as State | undefined) ?? 'connected');
  const [everConnected, setEverConnected] = useState(remote?.client?.state === 'connected');
  /** True once the outage has outlasted `OFFER_AFTER_MS`. */
  const [offerable, setOfferable] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!remote?.client) return;
    return window.electronAPI.onEvent('remote-connection', (p) => {
      const next = (p as { state: State }).state;
      setState(next);
      if (next === 'connected') setEverConnected(true);
    });
  }, [remote?.client]);

  /**
   * The countdown is keyed on the outage, not on the component: reconnecting
   * and dropping again restarts it, so a flapping link cannot accumulate
   * credit towards an offer over several short blips.
   */
  useEffect(() => {
    if (state === 'connected') {
      setOfferable(false);
      setConfirming(false);
      return;
    }
    const timer = setTimeout(() => { setOfferable(true); }, OFFER_AFTER_MS);
    return () => { clearTimeout(timer); };
  }, [state]);

  const switchToLocal = useCallback(() => {
    forceLocalMode(remote?.url ?? null, reload);
  }, [remote?.url, reload]);

  if (!remote?.client) return null;
  if (state === 'connected') return null;

  const reconnecting = state === 'reconnecting' || (state === 'connecting' && everConnected);
  return (
    <>
      <div
        role="status"
        className={cn(
          'flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium border-b',
          reconnecting ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : 'bg-destructive/10 text-destructive border-destructive/20',
        )}
      >
        {reconnecting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <WifiOff className="h-3.5 w-3.5" />}
        {reconnecting ? 'Reconnecting to OmniFex…' : state === 'connecting' ? 'Connecting to OmniFex…' : 'Disconnected from OmniFex'}
        {offerable && (
          <button
            type="button"
            onClick={() => { setConfirming(true); }}
            className="ml-1 rounded-md border border-current/30 px-2 py-0.5 font-medium hover:bg-current/10"
          >
            Work locally
          </button>
        )}
      </div>

      {/* A button the user pressed, never a modal that appeared on its own —
          an outage that heals while you are typing must not steal focus. */}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Work locally?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  OmniFex will run this window against the app itself instead of its
                  background service, and reload to do it.
                </p>
                <p>
                  Sessions started in the background service keep running — this window
                  just will not be able to see them until you reconnect. If the service
                  has actually stopped, they are already gone.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => { setConfirming(false); }}
              className="rounded-md px-3 py-1.5 text-sm border hover:bg-accent"
            >
              Keep trying
            </button>
            <button
              type="button"
              onClick={switchToLocal}
              className="rounded-md px-3 py-1.5 text-sm bg-primary text-primary-foreground font-medium"
            >
              Work locally
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The way back, shown only in a local mode the user chose.
 *
 * An ordinary legacy launch — no daemon configured, or `OMNIFEX_REMOTE=0` —
 * has nothing to go back to and gets nothing here. `forcedLocal` is what tells
 * the two apart; see `bootstrap.ts`.
 *
 * The probe is a plain `/healthz` GET against the address stashed when the
 * user switched. Deliberately not `remote:url`, which STARTS a daemon when
 * none is running and would resurrect the process every five seconds.
 */
export function LocalModeBanner({
  probe = fetchDaemonHealth,
  reload = () => { window.location.reload(); },
}: {
  probe?: (url: string) => Promise<DaemonHealthInfo | null>;
  reload?: () => void;
} = {}): React.JSX.Element | null {
  const remote = typeof window !== 'undefined' ? window.__omnifexRemote : undefined;
  const forced = remote?.forcedLocal === true;
  const [back, setBack] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!forced) return;
    const wsUrl = forcedDaemonUrl();
    // Nothing was stashed, so there is no address to ask about. State the mode
    // and offer nothing rather than polling a guess.
    const url = daemonHealthUrl({ mode: 'electron-remote', url: wsUrl }, '');
    if (!url) return;

    let cancelled = false;
    const tick = () => {
      probe(url)
        .then((info) => { if (!cancelled) setBack(info?.ok === true); })
        // Refused, timed out, or not a health body: still down. Never an error
        // on screen — the app is working, just not where it started.
        .catch(() => { if (!cancelled) setBack(false); });
    };
    tick();
    const timer = setInterval(tick, PROBE_EVERY_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [forced, probe]);

  if (!forced) return null;

  return (
    <>
      <div
        role="status"
        className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium border-b bg-sky-500/10 text-sky-500 border-sky-500/20"
      >
        <Laptop className="h-3.5 w-3.5" />
        Working locally
        {back && (
          <>
            <span className="opacity-70">· the background service is back</span>
            <button
              type="button"
              onClick={() => { setConfirming(true); }}
              className="ml-1 rounded-md border border-current/30 px-2 py-0.5 font-medium hover:bg-current/10"
            >
              Reconnect
            </button>
          </>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reconnect to the background service?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  OmniFex will reload and attach to the background service again, which
                  is where sessions started before you switched are still running.
                </p>
                <p>Anything you started locally keeps running in the app itself.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => { setConfirming(false); }}
              className="rounded-md px-3 py-1.5 text-sm border hover:bg-accent"
            >
              Stay local
            </button>
            <button
              type="button"
              onClick={() => { clearLocalMode(reload); }}
              className="rounded-md px-3 py-1.5 text-sm bg-primary text-primary-foreground font-medium"
            >
              Reconnect
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
