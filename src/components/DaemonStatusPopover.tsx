/**
 * Title-bar "Daemon" button: is this window talking to the OmniFex daemon,
 * and what is on the other end.
 *
 * The icon is the whole answer at a glance — green check connected, amber
 * spinner between sockets, red cross when there is no daemon (legacy IPC) or
 * the socket is down. The popover is the detail: version (against the app's
 * own), address, clients, sessions, uptime, refreshed from `/healthz` every
 * few seconds while it is open. Same shape as the Updates panel next to it.
 */
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { CircleCheck, CircleX, Loader2, RotateCw } from 'lucide-react';

import { Popover } from '@/components/ui/popover';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { TITLEBAR_LABEL } from '@/lib/titlebar';
import { daemonHealthUrl, fetchDaemonHealth, formatUptime, type DaemonHealthInfo } from '@/lib/remote/daemonStatus';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
/** `none` — no daemon in play at all: the app is on its built-in IPC. */
type DaemonState = ConnectionState | 'none';

const REFRESH_MS = 5_000;

const LABELS: Record<DaemonState, string> = {
  none: 'Not connected',
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  connected: 'Connected',
};

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-medium text-right', muted && 'text-muted-foreground')}>{value}</span>
    </div>
  );
}

export function DaemonStatusPopover({ appVersion }: { appVersion?: string }): React.JSX.Element {
  const remote = typeof window !== 'undefined' ? window.__omnifexRemote : undefined;
  const client = remote?.client ?? null;
  const healthUrl = daemonHealthUrl(remote, typeof location === 'undefined' ? '' : location.origin);

  const [state, setState] = useState<DaemonState>(() => (client ? (client.state as ConnectionState) : 'none'));
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<DaemonHealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  // Restart with a turn running needs a second click; this is the first one.
  const [confirmRestart, setConfirmRestart] = useState(false);

  useEffect(() => {
    if (!client || typeof window.electronAPI?.onEvent !== 'function') return;
    return window.electronAPI.onEvent('remote-connection', (p) => {
      setState((p as { state: ConnectionState }).state);
    });
  }, [client]);

  const refresh = useCallback(async () => {
    if (!healthUrl) return;
    setRefreshing(true);
    try {
      setHealth(await fetchDaemonHealth(healthUrl));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [healthUrl]);

  // Poll only while the panel is open; nobody needs the count while it is closed.
  useEffect(() => {
    if (!open || !healthUrl) return;
    void refresh();
    const t = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [open, healthUrl, refresh]);

  // A stale "are you sure?" must not survive closing the panel.
  useEffect(() => {
    if (!open) setConfirmRestart(false);
  }, [open]);

  const inFlight = health?.sessions.inFlight ?? 0;

  const restart = useCallback(async () => {
    setConfirmRestart(false);
    setRestarting(true);
    setRestartError(null);
    try {
      const { url } = await api.restartDaemon();
      if (!url) setRestartError('The daemon did not come back. See ~/Library/Logs/omnifex-server.log.');
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
    void refresh();
  }, [refresh]);

  const onRestartClick = () => {
    if (inFlight > 0 && !confirmRestart) {
      setConfirmRestart(true);
      return;
    }
    void restart();
  };

  const busy = state === 'connecting' || state === 'reconnecting';
  const good = state === 'connected';
  const daemonVersion = health?.version ?? client?.welcome?.daemonVersion ?? null;
  const versionMismatch = !!appVersion && !!daemonVersion && appVersion !== daemonVersion;
  const footerButton = cn(
    'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5',
    'text-[12px] font-medium transition-colors app-no-drag',
    'bg-accent/60 hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed',
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      className="px-0 py-0 w-[280px]"
      trigger={
        <motion.button
          data-daemon-trigger
          data-daemon-state={state}
          whileTap={{ scale: 0.97 }}
          transition={{ duration: 0.15 }}
          title={`Daemon: ${LABELS[state]}`}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors app-no-drag',
            'hover:bg-accent hover:text-accent-foreground',
          )}
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin text-amber-500" />
          ) : good ? (
            <CircleCheck size={16} className="text-emerald-500" />
          ) : (
            <CircleX size={16} className="text-red-500" />
          )}
          <span className={TITLEBAR_LABEL}>Daemon</span>
        </motion.button>
      }
      content={
        <>
          <div className="px-3.5 py-2.5 border-b border-border/50 flex items-center justify-between">
            <span className="text-base font-semibold">Daemon</span>
            <span
              data-daemon-status
              className={cn(
                'text-[11px] font-medium rounded-full px-2 py-0.5',
                good ? 'bg-emerald-500/10 text-emerald-500' : busy ? 'bg-amber-500/10 text-amber-500' : 'bg-red-500/10 text-red-500',
              )}
            >
              {LABELS[state]}
            </span>
          </div>
          <div className="px-3.5 py-2.5 space-y-2 text-[13px]">
            {state === 'none' ? (
              <p className="text-muted-foreground text-[12px] leading-snug">
                This window is using OmniFex&apos;s built-in IPC. The daemon is
                disabled (<code>OMNIFEX_REMOTE=0</code> or the remote setting) or
                it could not be started — see <code>~/Library/Logs/omnifex-server.log</code>.
                Sessions are not reachable from other devices.
              </p>
            ) : (
              <>
                <Row
                  label="Version"
                  value={
                    daemonVersion
                      ? versionMismatch
                        ? `${daemonVersion} (app ${appVersion})`
                        : daemonVersion
                      : '—'
                  }
                />
                {versionMismatch && (
                  <p data-daemon-version-mismatch className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-500">
                    The daemon is another build. It is replaced automatically once no turn is running.
                  </p>
                )}
                <Row label="Protocol" value={health ? `v${health.protocolVersion}` : '—'} />
                <Row label="Address" value={health ? `${health.host}:${health.port}` : remote?.url ?? '—'} />
                <Row label="Clients" value={health ? String(health.clients) : '—'} />
                <Row
                  label="Sessions"
                  value={health ? `${health.sessions.live} live · ${health.sessions.inFlight} running` : '—'}
                />
                <Row label="Uptime" value={health ? formatUptime(health.uptimeSec) : '—'} />
                {error && (
                  <p data-daemon-error className="rounded-md bg-red-500/10 px-2 py-1.5 text-[12px] text-red-400">
                    Could not read /healthz: {error}
                  </p>
                )}
                {restartError && (
                  <p data-daemon-restart-error className="rounded-md bg-red-500/10 px-2 py-1.5 text-[12px] text-red-400">
                    Restart failed: {restartError}
                  </p>
                )}
                {confirmRestart && (
                  <div data-daemon-restart-prompt className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-500 space-y-1.5">
                    <p>
                      {inFlight} running {inFlight === 1 ? 'turn' : 'turns'} will be stopped. Open tabs
                      show as stopped until their next message.
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        data-daemon-restart-confirm
                        onClick={() => { void restart(); }}
                        className="rounded px-2 py-0.5 font-medium bg-amber-500/20 hover:bg-amber-500/30 app-no-drag"
                      >
                        Stop and restart
                      </button>
                      <button
                        type="button"
                        data-daemon-restart-cancel
                        onClick={() => setConfirmRestart(false)}
                        className="rounded px-2 py-0.5 font-medium hover:bg-accent app-no-drag"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          {state !== 'none' && (
            <div className="px-3.5 py-2.5 border-t border-border/50 flex gap-2">
              <button
                type="button"
                data-daemon-refresh
                onClick={() => { void refresh(); }}
                disabled={refreshing || restarting}
                className={footerButton}
              >
                {refreshing ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    <span>Refreshing…</span>
                  </>
                ) : (
                  <span>Refresh</span>
                )}
              </button>
              <button
                type="button"
                data-daemon-restart
                onClick={onRestartClick}
                disabled={restarting}
                title="Stop the daemon and start a fresh one"
                className={footerButton}
              >
                {restarting ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    <span>Restarting…</span>
                  </>
                ) : (
                  <>
                    <RotateCw size={13} />
                    <span>Restart</span>
                  </>
                )}
              </button>
            </div>
          )}
        </>
      }
    />
  );
}
