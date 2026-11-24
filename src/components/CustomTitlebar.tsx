import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Settings, CircleFadingArrowUp, Loader2, RefreshCw, CheckCircle, AlertCircle, HardDrive, Brain, DollarSign, ScanSearch } from 'lucide-react';
import {
  TooltipProvider,
} from '@/components/ui/tooltip-modern';
import { Popover } from '@/components/ui/popover';
import { api, CLI_CHECKED_VERSION_SETTING_KEY, CLI_RELEASE_NOTICE_ID_PREFIX, type CliReviewStatus } from '@/lib/api';
import { cn } from '@/lib/utils';
import { TITLEBAR_LABEL } from '@/lib/titlebar';
import OmniFexIcon from '../../icons/icon.png';
import { TabStatusPopover } from '@/components/TabStatusPopover';
import { BrainRunIndicator } from '@/components/brain/BrainRunIndicator';
import { useOptionalAccounts } from '@/contexts/AccountsContext';
import { fireAndLog } from "@/lib/fireAndLog";
const MIN_CHECK_SPIN_MS = 700;

export const BACKGROUND_CHECK_MS = 60 * 60 * 1000;

// Dev never downloads releases: every `npm start` window would offer to install one over itself.
function autoDownloadEnabled(): boolean {
  return !import.meta.env.DEV;
}

/** Dev-only fake update states. Display only: the actions they unlock are no-ops. */
export const UPDATE_SIMULATION_STORAGE_KEY = 'omnifex.dev.simulateUpdates';
const SIMULATED_VERSION = '9.9.9';
// At the group border's own 60%: full strength reads thicker than the grey it lies over.
const RING_COLORS = {
  emerald: 'color-mix(in oklch, var(--color-emerald-500) 60%, transparent)',
  amber: 'color-mix(in oklch, var(--color-amber-500) 60%, transparent)',
} as const;
interface UpdateSimulation { cli: boolean; app: boolean; unreviewed: boolean }
const NO_SIMULATION: UpdateSimulation = { cli: false, app: false, unreviewed: false };
const SIMULATION_BOXES = [
  ['cli', 'Claude Code update'],
  ['app', 'OmniFex update'],
  ['unreviewed', 'Claude Code not yet reviewed'],
] as const;

function simulationEnabled(): boolean {
  return import.meta.env.DEV;
}

function readSimulation(): UpdateSimulation {
  if (!simulationEnabled()) return NO_SIMULATION;
  try {
    const v = JSON.parse(localStorage.getItem(UPDATE_SIMULATION_STORAGE_KEY) ?? 'null') as Partial<UpdateSimulation> | null;
    return { cli: v?.cli === true, app: v?.app === true, unreviewed: v?.unreviewed === true };
  } catch {
    return NO_SIMULATION;
  }
}

function simulateCliReview(real: CliReviewStatus | null, sim: UpdateSimulation): CliReviewStatus | null {
  if (!sim.cli && !sim.unreviewed) return real;
  const base: CliReviewStatus = real ?? {
    installed_version: null,
    reviewed_version: '—',
    checked_version: '—',
    unreviewed: false,
    latest_version: null,
    upgrade_available: false,
    repo_dir: null,
  };
  return {
    ...base,
    ...(sim.cli ? { upgrade_available: true, latest_version: SIMULATED_VERSION } : {}),
    ...(sim.unreviewed ? { unreviewed: true } : {}),
  };
}

export interface CliReviewLaunchRequest {
  repoDir: string;
  reviewedVersion: string;
  installedVersion: string;
}

interface CustomTitlebarProps {
  onSettingsClick?: () => void;
  onLimaClick?: () => void;
  onBrainClick?: () => void;
  onCostClick?: () => void;
  onCliReviewClick?: (request: CliReviewLaunchRequest) => void;
}

// WaitCancelled crosses IPC as a plain Error; only the message keeps the name.
function isWaitCancelled(err: unknown): boolean {
  return String((err as { message?: unknown } | null)?.message ?? err).includes('WaitCancelled');
}

export const CustomTitlebar: React.FC<CustomTitlebarProps> = ({
  onSettingsClick,
  onLimaClick,
  onBrainClick,
  onCostClick,
  onCliReviewClick,
}) => {
  const [appVersion, setAppVersion] = useState<string>('');

  // Optional: some shells don't mount AccountsProvider, and that must not crash the chrome.
  const accountsCtx = useOptionalAccounts();
  const accountsForIndicator = React.useMemo(
    () => (accountsCtx?.accounts ?? []).map((a) => ({ id: a.id, name: a.name })),
    [accountsCtx?.accounts],
  );

  type UpdateState =
    | { status: 'idle' }
    | { status: 'available'; version: string; downloadUrl: string; assetName: string; releaseUrl: string }
    | { status: 'downloading'; version: string; percent: number }
    | { status: 'ready'; filePath: string; version: string }
    | { status: 'waiting'; version: string; filePath: string; activeSessions: number }
    | { status: 'installing'; version: string }
    // A failed install retries from the downloaded file; re-downloading it failed straight back here.
    | { status: 'error'; failed: 'download'; downloadUrl: string; assetName: string; releaseUrl: string; version: string }
    | { status: 'error'; failed: 'install'; filePath: string; version: string };
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });
  // Timer-driven checks must see current state, not the closure's.
  const updateStateRef = React.useRef(updateState);
  updateStateRef.current = updateState;
  const [activeSessions, setActiveSessions] = useState<number>(0);
  useEffect(() => {
    return api.onSessionInFlightCount(setActiveSessions);
  }, []);

  interface DownloadTarget { version: string; downloadUrl: string; assetName: string; releaseUrl: string }

  const startDownload = useCallback(async (t: DownloadTarget) => {
    setUpdateState({ status: 'downloading', version: t.version, percent: 0 });
    try {
      const filePath = await api.downloadUpdate(t.downloadUrl, t.assetName);
      setUpdateState({ status: 'ready', filePath, version: t.version });
    } catch (e) {
      console.log(`[updater] download failed message=${String((e as { message?: unknown } | null)?.message ?? e)}`);
      setUpdateState({ status: 'error', failed: 'download', ...t });
    }
  }, []);

  // Only from a state with nothing on disk to lose, or the hourly check drops every pending download.
  const checkForUpdate = useCallback(async () => {
    const before = updateStateRef.current;
    const replaceable = before.status === 'idle' || before.status === 'available'
      || (before.status === 'error' && before.failed === 'download');
    if (!replaceable) return;
    try {
      const info = await api.checkForUpdate();
      console.log(`[updater] checkForUpdate() result available=${String(!!info?.available)}`);
      if (updateStateRef.current !== before) return;
      if (!info?.available) {
        setUpdateState({ status: 'idle' });
        return;
      }
      const target: DownloadTarget = {
        version: info.version,
        downloadUrl: info.downloadUrl,
        assetName: info.assetName,
        releaseUrl: info.releaseUrl,
      };
      if (autoDownloadEnabled()) {
        // Not awaited: the download must not hold the checking spinner.
        void startDownload(target);
      } else {
        setUpdateState({ status: 'available', ...target });
      }
    } catch {
      // Unreachable GitHub is "unknown": keep whatever we had.
    }
  }, [startDownload]);

  const [checkingHold, setCheckingHold] = useState(false);

  const withMinSpin = useCallback((work: Promise<unknown>) => {
    setCheckingHold(true);
    const minSpin = new Promise<void>((resolve) =>
      setTimeout(resolve, MIN_CHECK_SPIN_MS),
    );
    void Promise.all([work, minSpin]).finally(() => { setCheckingHold(false); });
  }, []);

  const [cliReview, setCliReview] = useState<CliReviewStatus | null>(null);
  const [simulation, setSimulation] = useState<UpdateSimulation>(readSimulation);
  const toggleSimulation = (key: keyof UpdateSimulation) => {
    setSimulation((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(UPDATE_SIMULATION_STORAGE_KEY, JSON.stringify(next)); } catch { /* best effort */ }
      return next;
    });
  };
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const checkCliReview = useCallback(async () => {
    setCliReview(await api.getClaudeCliReviewStatus());
  }, []);

  const markCliReleaseChecked = useCallback(async (version: string) => {
    if (simulation.unreviewed) { console.log('[simulate] mark checked skipped'); return; }
    await api.saveSetting(CLI_CHECKED_VERSION_SETTING_KEY, version);
    await checkCliReview();
  }, [checkCliReview, simulation.unreviewed]);

  // The CLI self-updates only from its interactive REPL, which stream-json sessions never render; this is the manual lever.
  type CliUpdateState =
    | { status: 'idle' }
    | { status: 'running' }
    | { status: 'done'; message: string }
    | { status: 'error'; message: string };
  const [cliUpdate, setCliUpdate] = useState<CliUpdateState>({ status: 'idle' });

  const runCliUpdate = useCallback(async () => {
    if (simulation.cli) { console.log('[simulate] claude update skipped'); return; }
    setCliUpdate({ status: 'running' });
    try {
      const result = await api.updateClaudeCli();
      // Trust the re-probe, not the exit code: `claude update` exits 0 when a version pin refuses the upgrade.
      const failed = result.accounts.filter((a) => !a.ok);
      if (failed.length > 0) {
        setCliUpdate({
          status: 'error',
          message: failed.map((a) => `${a.account}: ${a.message}`).join('\n'),
        });
      } else {
        setCliUpdate({
          status: 'done',
          message: result.upgraded
            ? `Updated to ${result.to ?? 'a newer build'}.`
            : `No change — still ${result.to ?? 'the installed build'}.`,
        });
      }
      await checkCliReview();
    } catch (err) {
      setCliUpdate({
        status: 'error',
        message: (err as Error)?.message || 'Update failed.',
      });
    }
  }, [checkCliReview, simulation.cli]);

  const checkEverything = useCallback(() => {
    withMinSpin(Promise.all([checkForUpdate(), checkCliReview()]));
  }, [checkForUpdate, checkCliReview, withMinSpin]);

  // Driven by the open event, not an effect on the flag: that re-fires on every check transition and loops. No time-based suppression: the launch check would start the clock.
  const handleUpdatesOpenChange = useCallback((next: boolean) => {
    setUpdatesOpen(next);
    if (!next) return;
    if (checkingHold) return;
    checkEverything();
  }, [checkingHold, checkEverything]);

  useEffect(() => {
    const t = setInterval(() => {
      void checkForUpdate();
      void checkCliReview();
    }, BACKGROUND_CHECK_MS);
    return () => { clearInterval(t); };
  }, [checkForUpdate, checkCliReview]);

  const announceVersion =
    cliReview?.upgrade_available && cliReview.latest_version ? cliReview.latest_version : null;
  useEffect(() => {
    if (!announceVersion) return;
    api.notifyClaudeCliRelease(announceVersion).catch(() => {});
  }, [announceVersion]);

  // setUpdatesOpen, not handleUpdatesOpenChange: the check that raised it has just run.
  useEffect(() => {
    return api.onNotificationClicked((data) => {
      if (typeof data?.id === 'string' && data.id.startsWith(CLI_RELEASE_NOTICE_ID_PREFIX)) {
        setUpdatesOpen(true);
      }
    });
  }, []);

  useEffect(() => {
    api.getAppVersion().then(setAppVersion).catch(() => {});
    // Through checkEverything: it stamps lastCheckStartedAt, which the open-popover check reads.
    checkEverything();

    const cleanupProgress = api.onUpdateProgress((data: { percent: number }) => {
      setUpdateState((prev) =>
        prev.status === 'downloading' ? { ...prev, percent: data.percent } : prev,
      );
    });

    const cleanupInstallStatus = api.onInstallStatus((data) => {
       
      console.log('[updater] install-status', data);
      setUpdateState((prev) => {
        if (prev.status === 'waiting' || prev.status === 'installing' || prev.status === 'ready') {
          if (data.phase === 'waiting') {
            return prev.status === 'waiting'
              ? { ...prev, activeSessions: data.activeSessions ?? 0 }
              : prev.status === 'installing'
                ? prev
                : {
                  status: 'waiting',
                  version: prev.version,
                  filePath: prev.filePath,
                  activeSessions: data.activeSessions ?? 0,
                };
          }
          if (data.phase === 'installing') {
            return { status: 'installing', version: prev.version };
          }
        }
        return prev;
      });
    });

    return () => {
      cleanupProgress();
      cleanupInstallStatus();
    };
  }, [checkEverything]);

  const runInstall = async (filePath: string, version: string): Promise<void> => {
    const force = activeSessions > 0;
     
    console.log(`[updater] runInstall force=${String(force)} activeSessions=${activeSessions}`);
    try {
      await api.installUpdate(filePath, version, force ? { force: true } : undefined);
      setUpdateState({ status: 'idle' });
    } catch (err) {
       
      console.log(`[updater] installUpdate failed message=${String((err as { message?: unknown } | null)?.message ?? err)}`);
      // Cancel also rejects this install: the user's choice, not a failure, so 'ready' must stand.
      if (isWaitCancelled(err)) return;
      setUpdateState({ status: 'error', failed: 'install', filePath, version });
    }
  };

  const handleUpdateClick = async () => {
    if (simulation.app) { console.log('[simulate] OmniFex install skipped'); return; }
    console.log(`[updater] handleUpdateClick status=${updateState.status} active=${activeSessions}`);
    if (updateState.status === 'available' || (updateState.status === 'error' && updateState.failed === 'download')) {
      const { version, downloadUrl, assetName, releaseUrl } = updateState;
      await startDownload({ version, downloadUrl, assetName, releaseUrl });
    } else if (updateState.status === 'ready') {
      const { filePath, version } = updateState;
      await runInstall(filePath, version);
    } else if (updateState.status === 'error' && updateState.failed === 'install') {
      // Back through 'ready': install-status events ignore an 'error' state.
      const { filePath, version } = updateState;
      setUpdateState({ status: 'ready', filePath, version });
      await runInstall(filePath, version);
    }
  };

  const handleInstallAnyway = async () => {
     
    console.log('[updater] handleInstallAnyway clicked', { status: updateState.status });
    if (updateState.status !== 'waiting') return;
    const { filePath, version } = updateState;
    try {
      await api.installUpdate(filePath, version, { force: true });
    } catch (err: unknown) {
      if (isWaitCancelled(err)) return;
      setUpdateState({ status: 'error', failed: 'install', filePath, version });
    }
  };

  const handleCancelInstall = async () => {
    if (updateState.status !== 'waiting') return;
    await api.cancelInstall().catch(() => {});
    const { filePath, version } = updateState;
    setUpdateState({ status: 'ready', filePath, version });
  };

  return (
    <TooltipProvider>
    <div
      className="relative z-[200] h-[60px] bg-background/95 backdrop-blur-sm flex items-center justify-between select-none border-b border-border/50 app-drag"
      data-app-drag-region
    >
      <div className="flex items-center pl-3 gap-1.5 app-no-drag">
        <img
          src={OmniFexIcon}
          alt="OmniFex"
          className="h-12 w-12 rounded-md select-none mr-2"
          draggable={false}
        />
        <div className="flex flex-col leading-tight select-none">
          <span className="text-2xl font-semibold tracking-tight">
            OmniFex
            {appVersion && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                ({appVersion})
              </span>
            )}
          </span>
          <span className="text-[11px] text-muted-foreground">by GreyChrist</span>
        </div>
      </div>

      <div className="flex-1 min-w-0 flex items-center justify-center px-4 self-stretch">
        <div className="min-w-0 max-w-full app-no-drag">
          <BrainRunIndicator accounts={accountsForIndicator} />
        </div>
      </div>

      <div className="flex items-center pr-5 gap-2 app-no-drag">

          <div className="inline-flex items-center rounded-md border border-border/60 bg-background/30 [&>*+*]:border-l [&>*+*]:border-border/50">
          {onLimaClick && (
            <motion.button
              onClick={onLimaClick}
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.15 }}
              title="Lima"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors app-no-drag"
            >
              <HardDrive size={16} />
              <span className={TITLEBAR_LABEL}>Lima</span>
            </motion.button>
          )}

          {onBrainClick && (
            <motion.button
              onClick={onBrainClick}
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.15 }}
              title="Brain"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors app-no-drag"
            >
              <Brain size={16} />
              <span className={TITLEBAR_LABEL}>Brain</span>
            </motion.button>
          )}

          {onCostClick && (
            <motion.button
              onClick={onCostClick}
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.15 }}
              title="Cost"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors app-no-drag"
            >
              <DollarSign size={16} />
              <span className={TITLEBAR_LABEL}>Cost</span>
            </motion.button>
          )}

          <TabStatusPopover />

          {onSettingsClick && (
            <motion.button
              onClick={onSettingsClick}
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.15 }}
              title="Settings"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors app-no-drag"
            >
              <Settings size={16} />
              <span className={TITLEBAR_LABEL}>Settings</span>
            </motion.button>
          )}

          {(() => {
            const isCheckingAnything = checkingHold;
            const shownUpdate: UpdateState = simulation.app
              ? { status: 'ready', filePath: '', version: SIMULATED_VERSION }
              : updateState;
            const shownCli = simulateCliReview(cliReview, simulation);
            const hasUpgrade =
              shownUpdate.status !== 'idle' ||
              (!!shownCli?.upgrade_available && !!shownCli.latest_version);
            const unreviewed = !!shownCli?.unreviewed;
            const ringTone: keyof typeof RING_COLORS | null =
              hasUpgrade ? 'emerald' : unreviewed ? 'amber' : null;
            return (
          <Popover
            open={updatesOpen}
            onOpenChange={handleUpdatesOpenChange}
            side="bottom"
            align="end"
            className="px-0 py-0 w-[280px]"
            /* No onClick: Popover's trigger handler already drives onOpenChange. */
            trigger={
              <motion.button
                data-updates-trigger
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                title={unreviewed && shownCli?.installed_version
                  ? `Updates — Claude Code ${shownCli.installed_version} not yet reviewed`
                  : 'Updates'}
                className={cn(
                  'relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors app-no-drag',
                  'hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {/* Inline box-shadow, not `ring-*`: styles.css forces `box-shadow: none !important` on rings. */}
                {ringTone && (
                  <span
                    aria-hidden
                    data-updates-ring
                    data-tone={ringTone}
                    className="pointer-events-none absolute -inset-px rounded-r-md animate-pulse"
                    style={{ boxShadow: `inset 0 0 0 1px ${RING_COLORS[ringTone]}` }}
                  />
                )}
                <CircleFadingArrowUp
                  size={16}
                  data-updates-icon
                  data-upgrade={hasUpgrade ? 'true' : undefined}
                  className={cn(isCheckingAnything && 'animate-spin', hasUpgrade && 'text-emerald-500 animate-pulse')}
                />
                <span className={TITLEBAR_LABEL}>Updates</span>
                {unreviewed && (
                  <ScanSearch
                    size={14}
                    aria-label={`Claude Code ${shownCli?.installed_version ?? ''} not yet reviewed`}
                    data-updates-unreviewed
                    className="text-amber-500 animate-pulse"
                  />
                )}
              </motion.button>
            }
            content={
            <>
              <div className="px-3.5 py-2.5 border-b border-border/50 flex items-center justify-between">
                <span className="text-base font-semibold">Updates</span>
                <button
                  type="button"
                  data-updates-refresh
                  title="Check again"
                  aria-label="Check for updates again"
                  onClick={checkEverything}
                  disabled={isCheckingAnything}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-default disabled:hover:bg-transparent app-no-drag"
                >
                  <RefreshCw size={14} className={cn(isCheckingAnything && 'animate-spin')} />
                </button>
              </div>
              <div className="px-3.5 py-2.5 space-y-2 text-[13px]">
                <div data-app-update-row className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">App</span>
                  <span className="font-medium">
                    {shownUpdate.status === 'idle'
                      ? `OmniFex ${appVersion || '—'}`
                      : `OmniFex ${appVersion || '—'} → ${shownUpdate.version} ${
                        shownUpdate.status === 'available' ? 'available'
                          : shownUpdate.status === 'downloading' ? `downloading ${Math.round(shownUpdate.percent)}%`
                          : shownUpdate.status === 'installing' ? 'installing'
                          : shownUpdate.status === 'error' ? (shownUpdate.failed === 'download' ? 'download failed' : 'install failed')
                          : 'ready'
                      }`}
                  </span>
                </div>
                {shownUpdate.status === 'waiting' ? (
                  <div data-app-update-waiting className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-500">
                    <Loader2 size={13} className="animate-spin shrink-0" />
                    <span className="flex-1">Waiting for {shownUpdate.activeSessions} session{shownUpdate.activeSessions === 1 ? '' : 's'}…</span>
                    <button
                      type="button"
                      onClick={fireAndLog('custom-titlebar:click', handleInstallAnyway)}
                      className="px-1.5 py-0.5 rounded bg-destructive/80 text-destructive-foreground hover:bg-destructive text-[11px] app-no-drag"
                    >
                      Install anyway
                    </button>
                    <button
                      type="button"
                      onClick={fireAndLog('custom-titlebar:click', handleCancelInstall)}
                      className="px-1.5 py-0.5 rounded bg-muted hover:bg-muted/80 text-[11px] app-no-drag"
                    >
                      Cancel
                    </button>
                  </div>
                ) : shownUpdate.status !== 'idle' && shownUpdate.status !== 'downloading' && (
                  <button
                    type="button"
                    data-app-update-install={shownUpdate.status === 'ready' || (shownUpdate.status === 'error' && shownUpdate.failed === 'install') ? '' : undefined}
                    data-app-update-retry={shownUpdate.status === 'error' && shownUpdate.failed === 'download' ? '' : undefined}
                    onClick={fireAndLog('custom-titlebar:click', handleUpdateClick)}
                    disabled={shownUpdate.status === 'installing'}
                    className={cn(
                      'flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5',
                      'text-[12px] font-medium transition-colors app-no-drag',
                      shownUpdate.status === 'error'
                        ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                        : 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20',
                      'disabled:opacity-60 disabled:cursor-not-allowed',
                    )}
                  >
                    {shownUpdate.status === 'installing' ? (
                      <><Loader2 size={13} className="animate-spin" /><span>Installing…</span></>
                    ) : shownUpdate.status === 'available' ? (
                      <span>Download {shownUpdate.version}</span>
                    ) : shownUpdate.status === 'error' && shownUpdate.failed === 'download' ? (
                      <span>Retry download</span>
                    ) : activeSessions > 0 ? (
                      <span>{`Install ${shownUpdate.version} — stops ${activeSessions} active session${activeSessions === 1 ? '' : 's'}`}</span>
                    ) : (
                      <span>Install {shownUpdate.version} →</span>
                    )}
                  </button>
                )}
                {shownCli && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Claude Code</span>
                    {/* One text node: split spans read as separate strings to tests and screen readers. */}
                    <span className="font-medium">
                      {shownCli.upgrade_available && shownCli.latest_version
                        ? `${shownCli.installed_version ?? 'not found'} → ${shownCli.latest_version} available`
                        : (shownCli.installed_version ?? 'not found')}
                    </span>
                  </div>
                )}
                {/* Gated on `latest_version` too: an unreachable registry is "unknown", never an upgrade target. */}
                {shownCli?.upgrade_available && shownCli.latest_version && (
                  <button
                    type="button"
                    data-cli-update-run
                    onClick={() => { void runCliUpdate(); }}
                    disabled={cliUpdate.status === 'running'}
                    className={cn(
                      'flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5',
                      'text-[12px] font-medium transition-colors app-no-drag',
                      'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20',
                      'disabled:opacity-60 disabled:cursor-not-allowed',
                    )}
                  >
                    {cliUpdate.status === 'running' ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        <span>Updating…</span>
                      </>
                    ) : (
                      <span>Update to {shownCli.latest_version} →</span>
                    )}
                  </button>
                )}
                {/* Outside the button's gate: a successful upgrade withdraws the button. */}
                {(cliUpdate.status === 'done' || cliUpdate.status === 'error') && (
                  <div
                    data-cli-update-result
                    className={cn(
                      'rounded-md px-2 py-1.5 text-[12px] whitespace-pre-line',
                      cliUpdate.status === 'error'
                        ? 'bg-red-500/10 text-red-400'
                        : 'bg-muted/60 text-muted-foreground',
                    )}
                  >
                    {cliUpdate.message}
                    {cliUpdate.status === 'done' && (
                      <span className="block mt-1 opacity-70">
                        Running sessions keep their current version.
                      </span>
                    )}
                  </div>
                )}
                {shownCli?.unreviewed && (() => {
                  const repoDir = shownCli.repo_dir;
                  const installedVersion = shownCli.installed_version;
                  const canLaunch = !!repoDir && !!onCliReviewClick && !!installedVersion;
                  const body = (
                    <>
                      <AlertCircle size={13} className="mt-px shrink-0" />
                      <span className="text-left">
                        Claude Code is ahead of the {shownCli.checked_version} changelog
                        OmniFex was last checked against — there may be new CLI behaviour
                        to support.
                        {canLaunch ? (
                          <span className="block mt-1 font-medium">Review it →</span>
                        ) : (
                          <span className="block mt-1 text-amber-500/70">
                            Set your OmniFex checkout in Settings → General to review it
                            from here.
                          </span>
                        )}
                      </span>
                    </>
                  );
                  const className =
                    'flex w-full gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-500';
                  return repoDir && installedVersion && onCliReviewClick ? (
                    <button
                      type="button"
                      data-cli-review-launch
                      onClick={() => {
                        if (simulation.unreviewed) { console.log('[simulate] review launch skipped'); return; }
                        onCliReviewClick({
                          repoDir,
                          reviewedVersion: shownCli.checked_version,
                          installedVersion,
                        });
                      }}
                      className={cn(className, 'app-no-drag transition-colors hover:bg-amber-500/20')}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={className}>{body}</div>
                  );
                })()}
                {shownCli?.unreviewed && shownCli.installed_version && (() => {
                  const version = shownCli.installed_version;
                  return (
                    <button
                      type="button"
                      data-cli-review-mark
                      onClick={() => { void markCliReleaseChecked(version); }}
                      className={cn(
                        'flex w-full items-center justify-center rounded-md px-2 py-1.5',
                        'text-[12px] font-medium transition-colors app-no-drag',
                        'bg-accent/60 hover:bg-accent',
                      )}
                    >
                      Mark {version} as checked
                    </button>
                  );
                })()}
                {/* `checked_version` is floored at `reviewed_version`, so inequality means "ahead". */}
                {shownCli && !shownCli.unreviewed
                  && shownCli.checked_version !== shownCli.reviewed_version && (
                  <div
                    data-cli-review-pending-release
                    className="flex items-start gap-1.5 rounded-md bg-muted/60 px-2 py-1.5 text-[12px] text-muted-foreground"
                  >
                    <CheckCircle
                      size={13}
                      aria-hidden
                      data-cli-review-checked-icon
                      className="mt-[2px] shrink-0 text-emerald-500"
                    />
                    <span>{`${shownCli.checked_version} checked and verified`}</span>
                  </div>
                )}
                {simulationEnabled() && (
                  <div data-update-simulation className="mt-1 space-y-1 border-t border-border/50 pt-2 text-[12px] text-muted-foreground">
                    <div className="text-[11px] font-medium uppercase tracking-wide">Dev · simulate</div>
                    {SIMULATION_BOXES.map(([key, label]) => (
                      <label key={key} className="flex cursor-pointer items-center gap-2 app-no-drag">
                        <input
                          type="checkbox"
                          checked={simulation[key]}
                          onChange={() => { toggleSimulation(key); }}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </>
            }
          />
            );
          })()}
          </div>
      </div>
    </div>
    </TooltipProvider>
  );
};
