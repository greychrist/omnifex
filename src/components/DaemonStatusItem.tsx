/**
 * The daemon as a status-bar readout: `daemon live`, and the detail behind it.
 *
 * Replaced the title bar's "Daemon" button. Connectivity matters most to the
 * session you are in — the socket is global, but whether the daemon is
 * delivering THIS session's events is not (see `useDaemonLink`), and only a
 * session-scoped popover can say both. So the readout is the trigger, and the
 * popover adds the daemon's own facts — version (against the app's), address,
 * clients, sessions, uptime, refreshed from `/healthz` every few seconds while
 * open — plus Restart.
 *
 * Laid out in the account popover's grammar (`AccountDetails`): small-caps
 * section labels, `label … value` rows in xs with mono values, h-6 outline
 * buttons, tinted notes. The status-bar popovers are one family.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';
import { POPOVER_SECTION } from '@/components/ui/popover-list';
import { LinkGlyph, type LinkState } from '@/components/ChatStatusBar';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { daemonHealthUrl, fetchDaemonHealth, formatUptime, type DaemonHealthInfo } from '@/lib/remote/daemonStatus';

type ConnectionState = NonNullable<LinkState['connection']>;

const REFRESH_MS = 5_000;

const LABELS: Record<ConnectionState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  connected: 'Connected',
};

const BUTTON = 'h-6 px-2 text-[11px]';

function Row({ label, value, className }: { label: string; value: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-foreground/50">{label}</span>
      <span className={cn('font-mono text-foreground/90 truncate', className)}>{value}</span>
    </div>
  );
}

export function DaemonStatusItem({ link }: { link: LinkState }): React.JSX.Element | null {
  const { connection, delivering } = link;
  const remote = typeof window !== 'undefined' ? window.__omnifexRemote : undefined;
  const healthUrl = daemonHealthUrl(remote, typeof location === 'undefined' ? '' : location.origin);

  const [open, setOpen] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [health, setHealth] = useState<DaemonHealthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  // Restart with a turn running needs a second click; this is the first one.
  const [confirmRestart, setConfirmRestart] = useState(false);

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

  // Asked on first open, not on mount: every open tab mounts a status bar.
  useEffect(() => {
    if (!open || appVersion !== null) return;
    api.getAppVersion().then(setAppVersion).catch(() => {});
  }, [open, appVersion]);

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

  // No daemon on this page: nothing to report — see LinkGlyph.
  if (connection === null) return null;

  const onRestartClick = () => {
    if (inFlight > 0 && !confirmRestart) {
      setConfirmRestart(true);
      return;
    }
    void restart();
  };

  const connected = connection === 'connected';
  const busy = connection === 'connecting' || connection === 'reconnecting';
  const daemonVersion = health?.version ?? remote?.client?.welcome?.daemonVersion ?? null;
  const versionMismatch = !!appVersion && !!daemonVersion && appVersion !== daemonVersion;
  // On the web this daemon is what served the page, so a mismatch means the
  // loaded bundle is stale — the desktop's "replaced once idle" is the wrong
  // story, and there is no separate app to name.
  const isWeb = remote?.mode === 'web';

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      side="bottom"
      className="w-80"
      trigger={
        <button
          type="button"
          aria-label={`daemon: ${LABELS[connection]}`}
          aria-expanded={open}
          title="Click for daemon details"
          className="flex items-center rounded hover:bg-muted/60"
        >
          <LinkGlyph connection={connection} delivering={delivering} />
        </button>
      }
      content={
        <div className="flex flex-col gap-3 text-left">
          <div className="flex flex-col gap-1.5">
            <div className={cn(POPOVER_SECTION, 'flex items-center justify-between gap-2')}>
              <span>daemon</span>
              <span
                data-daemon-status
                className={cn(
                  'normal-case tracking-normal font-medium',
                  connected ? 'text-emerald-500' : busy ? 'text-amber-500' : 'text-red-500',
                )}
              >
                {LABELS[connection]}
              </span>
            </div>
            <div className="flex flex-col gap-1 text-xs">
              <Row
                label="Version"
                value={
                  daemonVersion
                    ? versionMismatch
                      ? `${daemonVersion} (${isWeb ? 'page' : 'app'} ${appVersion})`
                      : daemonVersion
                    : '—'
                }
                className={versionMismatch ? 'text-amber-500' : undefined}
              />
              <Row label="Protocol" value={health ? `v${health.protocolVersion}` : '—'} />
              <Row label="Address" value={health ? `${health.host}:${health.port}` : remote?.url ?? '—'} />
              <Row label="Clients" value={health ? String(health.clients) : '—'} />
              <Row
                label="Sessions"
                value={health ? `${health.sessions.live} live · ${health.sessions.inFlight} running` : '—'}
              />
              <Row label="Uptime" value={health ? formatUptime(health.uptimeSec) : '—'} />
            </div>
            {versionMismatch && (
              <div data-daemon-version-mismatch className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">
                {isWeb
                  ? 'This page is another build. Reload to pick up the daemon’s.'
                  : 'The daemon is another build. It is replaced automatically once no turn is running.'}
              </div>
            )}
          </div>

          {/* The fact the socket state alone cannot give: the daemon fans a
              session out only to subscribed clients. */}
          <div className="flex flex-col gap-1.5">
            <div className={POPOVER_SECTION}>this session</div>
            <div data-daemon-session className="flex justify-between gap-2 text-xs">
              <span className="text-foreground/50">Events</span>
              <span className={cn('font-mono', connected && delivering ? 'text-emerald-500' : 'text-amber-500')}>
                {connected && delivering ? 'Receiving' : 'Not receiving'}
              </span>
            </div>
            {connected && !delivering && (
              <div className="text-[11px] text-foreground/60">
                The daemon is not sending this session&apos;s events, so nothing new
                will appear here. Reloading the window re-subscribes.
              </div>
            )}
          </div>

          {error && (
            <div data-daemon-error className="rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-500 break-words">
              Could not read /healthz: {error}
            </div>
          )}
          {restartError && (
            <div data-daemon-restart-error className="rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-500 break-words">
              Restart failed: {restartError}
            </div>
          )}
          {confirmRestart && (
            <div data-daemon-restart-prompt className="flex flex-col gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">
              <span>
                {inFlight} running {inFlight === 1 ? 'turn' : 'turns'} will be stopped. Open tabs
                show as stopped until their next message.
              </span>
              <div className="flex gap-2">
                <Button
                  data-daemon-restart-confirm
                  variant="destructive"
                  size="sm"
                  className={BUTTON}
                  onClick={() => { void restart(); }}
                >
                  Stop and restart
                </Button>
                <Button
                  data-daemon-restart-cancel
                  variant="outline"
                  size="sm"
                  className={BUTTON}
                  onClick={() => { setConfirmRestart(false); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              data-daemon-refresh
              variant="outline"
              size="sm"
              className={BUTTON}
              onClick={() => { void refresh(); }}
              disabled={refreshing || restarting}
            >
              <RefreshCw className={cn('w-3 h-3 mr-1', refreshing && 'animate-spin')} />
              Refresh
            </Button>
            <Button
              data-daemon-restart
              variant="outline"
              size="sm"
              className={BUTTON}
              onClick={onRestartClick}
              disabled={restarting}
              title="Stop the daemon and start a fresh one"
            >
              <RotateCw className={cn('w-3 h-3 mr-1', restarting && 'animate-spin')} />
              {restarting ? 'Restarting…' : 'Restart daemon'}
            </Button>
          </div>
        </div>
      }
    />
  );
}
