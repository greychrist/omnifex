import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Settings, CircleFadingArrowUp, Loader2, CheckCircle, AlertCircle, HardDrive, Brain, DollarSign, ScanSearch } from 'lucide-react';
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
// Minimum visible spin time on the upgrade-check button. Local checks can
// resolve in <100ms which makes the spinner flash and feels like nothing
// happened; holding for ~700ms gives clear feedback.
const MIN_CHECK_SPIN_MS = 700;

/** How often both updates are re-checked while the app is open. Opening the
 *  popover and launching still check immediately; this is what catches a
 *  release published while nobody is looking. */
export const BACKGROUND_CHECK_MS = 60 * 60 * 1000;

/** The dev renderer never fetches release zips: every `npm start` window
 *  would pull one an hour and offer to install a release over itself. Read
 *  per call so a test can stub it. */
function autoDownloadEnabled(): boolean {
  return !import.meta.env.DEV;
}

/** What the drift warning hands its host when clicked. */
export interface CliReviewLaunchRequest {
  /** OmniFex checkout to run the review in (`CliReviewStatus.repo_dir`). */
  repoDir: string;
  /** Watermark this build was reviewed at — the low end of the range. */
  reviewedVersion: string;
  /** Version the user is actually running — the high end. */
  installedVersion: string;
}

interface CustomTitlebarProps {
  onSettingsClick?: () => void;
  onLimaClick?: () => void;
  onBrainClick?: () => void;
  onCostClick?: () => void;
  /** Launches the changelog review. Omit to leave the drift warning as text. */
  onCliReviewClick?: (request: CliReviewLaunchRequest) => void;
}


/** Main rethrows the installer's `WaitCancelled` through IPC as a plain Error,
 *  so the name only survives inside the message. */
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

  // Optional: the titlebar also renders in shells that do not mount
  // AccountsProvider, and a missing provider must cost the indicator its
  // labels, not crash the window chrome.
  const accountsCtx = useOptionalAccounts();
  const accountsForIndicator = React.useMemo(
    () => (accountsCtx?.accounts ?? []).map((a) => ({ id: a.id, name: a.name })),
    [accountsCtx?.accounts],
  );

  // --- Update state ---
  type UpdateState =
    | { status: 'idle' }
    | { status: 'available'; version: string; downloadUrl: string; assetName: string; releaseUrl: string }
    | { status: 'downloading'; version: string; percent: number }
    | { status: 'ready'; filePath: string; version: string }
    | { status: 'waiting'; version: string; filePath: string; activeSessions: number }
    | { status: 'installing'; version: string }
    // `failed` says what Retry repeats. A failed install has a finished
    // download on disk, so it retries the install from that file; it used to
    // carry the file path as `downloadUrl` and "re-download" it, which failed
    // straight back into this state.
    | { status: 'error'; failed: 'download'; downloadUrl: string; assetName: string; releaseUrl: string; version: string }
    | { status: 'error'; failed: 'install'; filePath: string; version: string };
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });
  // Read by the checks, which run from timers and must see the state as it is
  // now rather than as it was when the callback was created.
  const updateStateRef = React.useRef(updateState);
  updateStateRef.current = updateState;
  // Live count of sessions whose turn is in flight. Drives the upgrade
  // button's "active sessions" warning state — when an update is available
  // and this is > 0, clicking the button installs anyway (force=true).
  const [activeSessions, setActiveSessions] = useState<number>(0);
  useEffect(() => {
    return api.onSessionInFlightCount(setActiveSessions);
  }, []);

  type DownloadTarget = { version: string; downloadUrl: string; assetName: string; releaseUrl: string };

  // Fetch the release zip and stop at 'ready': installing is the user's click.
  const startDownload = useCallback(async (t: DownloadTarget) => {
    setUpdateState({ status: 'downloading', version: t.version, percent: 0 });
    try {
      const filePath = await api.downloadUpdate(t.downloadUrl, t.assetName);
      setUpdateState({ status: 'ready', filePath, version: t.version });
    } catch (e: any) {
      console.log(`[updater] download failed message=${String((e?.message ?? e) as unknown)}`);
      setUpdateState({ status: 'error', failed: 'download', ...t });
    }
  }, []);

  /**
   * Ask GitHub for a newer OmniFex, and start downloading it when there is one.
   *
   * Only from a state with nothing on disk to lose. A check that ran while a
   * download was ready or an install was waiting used to drop the state back to
   * 'available' and forget the file; now that the hourly check runs unattended
   * that would happen to every pending update. A failed download is the one
   * busy state it may replace — the next check is the retry.
   */
  const checkForUpdate = useCallback(async () => {
    const before = updateStateRef.current;
    const replaceable = before.status === 'idle' || before.status === 'available'
      || (before.status === 'error' && before.failed === 'download');
    if (!replaceable) return;
    try {
      const info = await api.checkForUpdate();
      console.log(`[updater] checkForUpdate() result available=${String(!!info?.available)}`);
      if (updateStateRef.current !== before) return; // something moved meanwhile
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
        // Not awaited: the check is done, and the download must not hold the
        // checking spinner for the length of a 100 MB fetch.
        void startDownload(target);
      } else {
        setUpdateState({ status: 'available', ...target });
      }
    } catch {
      // Unreachable GitHub is "unknown": keep whatever we had.
    }
  }, [startDownload]);

  // True while any check is running (manual or on-mount). Enforces a
  // minimum visible spin so cached responses still produce visible
  // feedback rather than a flicker.
  const [checkingHold, setCheckingHold] = useState(false);

  // Wrap a check in the min-spin hold. The hold clears once both the work
  // and the minimum-spin timer have elapsed, whichever takes longer.
  const withMinSpin = useCallback((work: Promise<unknown>) => {
    setCheckingHold(true);
    const minSpin = new Promise<void>((resolve) =>
      setTimeout(resolve, MIN_CHECK_SPIN_MS),
    );
    void Promise.all([work, minSpin]).finally(() => { setCheckingHold(false); });
  }, []);

  // --- Claude CLI changelog watermark ---
  // OmniFex wraps a CLI it doesn't ship, so a CLI release can silently move a
  // surface we parse. This mirrors the signal the pinned SDK version used to
  // give us: main compares the installed binary against the release whose
  // changelog this build was reviewed against.
  const [cliReview, setCliReview] = useState<CliReviewStatus | null>(null);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const checkCliReview = useCallback(async () => {
    setCliReview(await api.getClaudeCliReviewStatus());
  }, []);

  // Marks the installed release as read without cutting a build. The built-in
  // watermark only moves with a release; this setting is what lets a review
  // that changed nothing clear the unreviewed icon. Main floors it at the built-in value.
  const markCliReleaseChecked = useCallback(async (version: string) => {
    await api.saveSetting(CLI_CHECKED_VERSION_SETTING_KEY, version);
    await checkCliReview();
  }, [checkCliReview]);

  // --- Forced CLI update ---
  // The CLI's self-updater is a component of its Ink REPL, so it only ever
  // fires when the binary is launched interactively. OmniFex's default session
  // mode is headless stream-json, which renders no REPL — releases pile up and
  // nothing in the app moves them. This button is the manual lever.
  type CliUpdateState =
    | { status: 'idle' }
    | { status: 'running' }
    | { status: 'done'; message: string }
    | { status: 'error'; message: string };
  const [cliUpdate, setCliUpdate] = useState<CliUpdateState>({ status: 'idle' });

  const runCliUpdate = useCallback(async () => {
    setCliUpdate({ status: 'running' });
    try {
      const result = await api.updateClaudeCli();
      // `upgraded` comes from re-probing the binary, not from the CLI's exit
      // code: `claude update` exits 0 both when it is already current and when
      // a managed-settings version pin refuses the upgrade. Reporting success
      // off a clean exit would tell the user it worked in the one case where
      // they most need to know it didn't.
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
      // Re-read so the row reflects the binary now on disk, which also
      // withdraws this button once the upgrade has actually landed.
      await checkCliReview();
    } catch (err) {
      setCliUpdate({
        status: 'error',
        message: (err as Error)?.message || 'Update failed.',
      });
    }
  }, [checkCliReview]);

  // One-click refresh for the upgrade-check button. Checks both the app
  // release and the CLI watermark — one button, one answer.
  const checkEverything = useCallback(() => {
    withMinSpin(Promise.all([checkForUpdate(), checkCliReview()]));
  }, [checkForUpdate, checkCliReview, withMinSpin]);

  /**
   * Opening the panel IS the request, so it checks on the way open.
   *
   * Driven by the open EVENT, not by an effect watching the open FLAG. A check
   * moves state through several transitions, and an effect
   * keyed on the flag re-runs on each of those while the popover is still
   * open — so it would re-fire forever. Handling the transition fires exactly
   * once per open and cannot loop.
   *
   * The one guard is "not while a check is already running": opening during
   * the launch check would otherwise double every probe. There is deliberately
   * no time-based suppression. A 60s freshness window was tried in v0.4.139
   * and was wrong — the launch check starts the clock, so opening the panel in
   * the first minute after starting the app did nothing at all, which is
   * exactly when anyone looks.
   */
  const handleUpdatesOpenChange = useCallback((next: boolean) => {
    setUpdatesOpen(next);
    if (!next) return;
    if (checkingHold) return;
    checkEverything();
  }, [checkingHold, checkEverything]);

  // The unattended check: no spinner, because nobody asked. This is what
  // finds a release published while the app sits open.
  useEffect(() => {
    const t = setInterval(() => {
      void checkForUpdate();
      void checkCliReview();
    }, BACKGROUND_CHECK_MS);
    return () => { clearInterval(t); };
  }, [checkForUpdate, checkCliReview]);

  // Announce a newly published Claude Code release. Keyed on the version, so
  // re-checks that find the same one don't re-run it; the daemon's claim makes
  // it once per version across windows and relaunches. No window open means
  // no claim, so the launch check announces it later — that is the hold.
  const announceVersion =
    cliReview?.upgrade_available && cliReview.latest_version ? cliReview.latest_version : null;
  useEffect(() => {
    if (!announceVersion) return;
    api.notifyClaudeCliRelease(announceVersion).catch(() => {});
  }, [announceVersion]);

  // Clicking that notification opens the panel it points at. setUpdatesOpen,
  // not handleUpdatesOpenChange: the check that raised it has just run.
  useEffect(() => {
    return api.onNotificationClicked((data) => {
      if (typeof data?.id === 'string' && data.id.startsWith(CLI_RELEASE_NOTICE_ID_PREFIX)) {
        setUpdatesOpen(true);
      }
    });
  }, []);

  // Fetch app version + check for updates on mount.
  useEffect(() => {
    api.getAppVersion().then(setAppVersion).catch(() => {});
    // Through checkEverything, not the two checks directly: it is what stamps
    // `lastCheckStartedAt`, and the open-popover auto-check reads that stamp.
    // Composing the pair inline here left the launch check unstamped, so the
    // first open always re-probed a result that was seconds old.
    checkEverything();

    // Listen for download progress
    const cleanupProgress = api.onUpdateProgress((data: { percent: number }) => {
      setUpdateState((prev) =>
        prev.status === 'downloading' ? { ...prev, percent: data.percent } : prev,
      );
    });

    const cleanupInstallStatus = api.onInstallStatus((data) => {
      // Diagnostic: see exactly what the install gate reports on every tick,
      // including the per-tab status snapshot. Useful for figuring out why
      // the wait-for-idle gate cleared when sessions look active in the UI.
       
      console.log('[updater] install-status', data);
      setUpdateState((prev) => {
        if (prev.status === 'waiting' || prev.status === 'installing' || prev.status === 'ready') {
          if (data.phase === 'waiting') {
            return prev.status === 'waiting'
              ? { ...prev, activeSessions: data.activeSessions ?? 0 }
              : prev.status === 'installing'
                ? prev // already past the wait — ignore late waiting events
                : { // 'ready' transitioning into 'waiting'
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

  // One-click install. We keep download + install internal so the user only
  // ever sees one button press. `force` is wired to the live in-flight session
  // count so clicking the button while sessions are mid-turn calls stopAll()
  // on the main side and then installs.
  const runInstall = async (filePath: string, version: string): Promise<void> => {
    const force = activeSessions > 0;
     
    console.log(`[updater] runInstall force=${String(force)} activeSessions=${activeSessions}`);
    try {
      await api.installUpdate(filePath, version, force ? { force: true } : undefined);
      // executeInstall calls app.quit() on success — we never reach here.
      setUpdateState({ status: 'idle' });
    } catch (err: any) {
       
      console.log(`[updater] installUpdate failed message=${String((err?.message ?? err) as unknown)}`);
      // Cancel rejects the pending install too — main's wait loop throws
      // WaitCancelled on its next poll, after handleCancelInstall has already
      // put the button back to 'ready'. That is the user's choice, not a
      // failure, and must not overwrite 'ready' with an error.
      if (isWaitCancelled(err)) return;
      setUpdateState({ status: 'error', failed: 'install', filePath, version });
    }
  };

  // The OmniFex row's one button: what it does depends on where the update is.
  const handleUpdateClick = async () => {
    console.log(`[updater] handleUpdateClick status=${updateState.status} active=${activeSessions}`);
    if (updateState.status === 'available' || (updateState.status === 'error' && updateState.failed === 'download')) {
      const { version, downloadUrl, assetName, releaseUrl } = updateState;
      await startDownload({ version, downloadUrl, assetName, releaseUrl });
    } else if (updateState.status === 'ready') {
      const { filePath, version } = updateState;
      await runInstall(filePath, version);
    } else if (updateState.status === 'error' && updateState.failed === 'install') {
      // Back through 'ready' so the install-status events can move the row
      // into 'waiting' / 'installing' — they ignore an 'error' state.
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
    // Drop back to 'ready' so the user can retry.
    const { filePath, version } = updateState;
    setUpdateState({ status: 'ready', filePath, version });
  };

  return (
    <TooltipProvider>
    <div
      className="relative z-[200] h-[60px] bg-background/95 backdrop-blur-sm flex items-center justify-between select-none border-b border-border/50 app-drag"
      data-app-drag-region
    >
      {/* Left side - app icon + brand. Traffic lights live in the OS-native
           title bar above this row, so no left padding needed. */}
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

      {/* Brain indexing, which since Plan 8 runs while the user works. The
          Brain tab owns the detail; this is the ambient "it is happening, and
          here is where it is" signal. `useOptionalAccounts` because the
          titlebar renders in shells without the provider.

          A flex child between the brand and the nav group, `flex-1 min-w-0`,
          so it only ever has the gap between them and wraps or truncates
          inside it. It used to be absolutely centred so it would not slide
          when the nav group's width changed — and on a narrow window it sat
          on top of the buttons instead. Centred within the gap is close
          enough; colliding is not. */}
      <div className="flex-1 min-w-0 flex items-center justify-center px-4 self-stretch">
        <div className="min-w-0 max-w-full app-no-drag">
          <BrainRunIndicator accounts={accountsForIndicator} />
        </div>
      </div>

      {/* Right side - Navigation icons */}
      <div className="flex items-center pr-5 gap-2 app-no-drag">

          {/* Icon button group — segmented-control style, single bordered
              container with internal dividers. Drops individual rounding so
              the buttons read as one connected group. overflow-visible so
              the Sessions popover can escape the group's bounds (otherwise
              its absolutely-positioned content gets clipped to ~32px tall). */}
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
            /* Two signals, deliberately different in kind. Green on the icon:
               an upgrade is waiting, for either OmniFex or Claude Code — one
               colour for both, the rows inside say which. A second icon: the
               installed Claude Code has not been reviewed, which is work to
               do rather than an upgrade to take. An unknown registry answer
               (`latest_version` null) is neither. */
            const hasUpgrade =
              updateState.status !== 'idle' ||
              (!!cliReview?.upgrade_available && !!cliReview.latest_version);
            const unreviewed = !!cliReview?.unreviewed;
            return (
          <Popover
            open={updatesOpen}
            onOpenChange={handleUpdatesOpenChange}
            side="bottom"
            align="end"
            className="px-0 py-0 w-[280px]"
            /* The button carries no onClick: Popover wraps the trigger in
               its own click handler that drives onOpenChange. A second toggle
               here was redundant and only agreed with it by coincidence. */
            trigger={
              <motion.button
                data-updates-trigger
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                title={unreviewed && cliReview?.installed_version
                  ? `Updates — Claude Code ${cliReview.installed_version} not yet reviewed`
                  : 'Updates'}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors app-no-drag',
                  'hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <CircleFadingArrowUp
                  size={16}
                  data-updates-icon
                  data-upgrade={hasUpgrade ? 'true' : undefined}
                  className={cn(isCheckingAnything && 'animate-spin', hasUpgrade && 'text-emerald-500')}
                />
                <span className={TITLEBAR_LABEL}>Updates</span>
                {unreviewed && (
                  <ScanSearch
                    size={14}
                    aria-label={`Claude Code ${cliReview?.installed_version ?? ''} not yet reviewed`}
                    data-updates-unreviewed
                    className="text-amber-500"
                  />
                )}
              </motion.button>
            }
            content={
            <>
              <div className="px-3.5 py-2.5 border-b border-border/50 flex items-center justify-between">
                <span className="text-base font-semibold">Updates</span>
                {isCheckingAnything && (
                  <Loader2 size={14} className="animate-spin text-muted-foreground" />
                )}
              </div>
              <div className="px-3.5 py-2.5 space-y-2 text-[13px]">
                <div data-app-update-row className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">App</span>
                  {/* One text node, for the same reason as the Claude Code row. */}
                  <span className="font-medium">
                    {updateState.status === 'idle'
                      ? `OmniFex ${appVersion || '—'}`
                      : `OmniFex ${appVersion || '—'} → ${updateState.version} ${
                        updateState.status === 'available' ? 'available'
                          : updateState.status === 'downloading' ? `downloading ${Math.round(updateState.percent)}%`
                          : updateState.status === 'installing' ? 'installing'
                          : updateState.status === 'error' ? (updateState.failed === 'download' ? 'download failed' : 'install failed')
                          : 'ready'
                      }`}
                  </span>
                </div>
                {updateState.status === 'waiting' ? (
                  <div data-app-update-waiting className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-500">
                    <Loader2 size={13} className="animate-spin shrink-0" />
                    <span className="flex-1">Waiting for {updateState.activeSessions} session{updateState.activeSessions === 1 ? '' : 's'}…</span>
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
                ) : updateState.status !== 'idle' && updateState.status !== 'downloading' && (
                  <button
                    type="button"
                    data-app-update-install={updateState.status === 'ready' || (updateState.status === 'error' && updateState.failed === 'install') ? '' : undefined}
                    data-app-update-retry={updateState.status === 'error' && updateState.failed === 'download' ? '' : undefined}
                    onClick={fireAndLog('custom-titlebar:click', handleUpdateClick)}
                    disabled={updateState.status === 'installing'}
                    className={cn(
                      'flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5',
                      'text-[12px] font-medium transition-colors app-no-drag',
                      updateState.status === 'error'
                        ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                        : 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20',
                      'disabled:opacity-60 disabled:cursor-not-allowed',
                    )}
                  >
                    {updateState.status === 'installing' ? (
                      <><Loader2 size={13} className="animate-spin" /><span>Installing…</span></>
                    ) : updateState.status === 'available' ? (
                      <span>Download {updateState.version}</span>
                    ) : updateState.status === 'error' && updateState.failed === 'download' ? (
                      <span>Retry download</span>
                    ) : activeSessions > 0 ? (
                      <span>{`Install ${updateState.version} — stops ${activeSessions} active session${activeSessions === 1 ? '' : 's'}`}</span>
                    ) : (
                      <span>Install {updateState.version} →</span>
                    )}
                  </button>
                )}
                {/* Claude Code row. The version alone is the useful line; the
                    watermark note only appears when the CLI has actually
                    moved past what we've reviewed, so the popover stays
                    two lines in the steady state.

                    The `→ available` suffix is the whole reason this row is
                    more than a readout: the CLI self-updates only when it is
                    launched directly, never from OmniFex's own pty spawns, so
                    without it the popover reads as a steady state while
                    releases pile up. Absent when the registry couldn't be
                    reached — an unknown answer shows nothing rather than
                    implying "up to date". */}
                {cliReview && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Claude Code</span>
                    {/* One text node, not a nest of styled spans: split across
                        elements this reads as "2.1.241" and "→ available" to
                        anything walking direct text children, including the
                        tests and a screen reader. */}
                    <span className="font-medium">
                      {cliReview.upgrade_available && cliReview.latest_version
                        ? `${cliReview.installed_version ?? 'not found'} → ${cliReview.latest_version} available`
                        : (cliReview.installed_version ?? 'not found')}
                    </span>
                  </div>
                )}
                {/* Forcing the update. Gated on `latest_version` as well as
                    `upgrade_available` so an unreachable registry — which
                    reports "unknown", never "up to date" — can't offer an
                    upgrade to a target we don't know. */}
                {cliReview?.upgrade_available && cliReview.latest_version && (
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
                      <span>Update to {cliReview.latest_version} →</span>
                    )}
                  </button>
                )}
                {/* Result line. Lives outside the button's own gate because a
                    successful upgrade withdraws the button — the outcome has
                    to outlive the control that caused it. `whitespace-pre-line`
                    because a multi-account failure is one line per account. */}
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
                {/* The warning IS the action: clicking it opens a session in
                    the OmniFex checkout running the review for exactly the
                    range that drifted. Only a button when we have somewhere to
                    launch and a host willing to launch it — a dead click
                    target is worse than plain text. */}
                {cliReview?.unreviewed && (() => {
                  const repoDir = cliReview.repo_dir;
                  const installedVersion = cliReview.installed_version;
                  const canLaunch = !!repoDir && !!onCliReviewClick && !!installedVersion;
                  const body = (
                    <>
                      <AlertCircle size={13} className="mt-px shrink-0" />
                      <span className="text-left">
                        Claude Code is ahead of the {cliReview.checked_version} changelog
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
                        onCliReviewClick({
                          repoDir,
                          reviewedVersion: cliReview.checked_version,
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
                {/* Separate from the launch button above, which can't nest
                    another button. The user's word that the review is read. */}
                {cliReview?.unreviewed && cliReview.installed_version && (() => {
                  const version = cliReview.installed_version;
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
                {/* Checked but not shipped: no build carries a review of this
                    release yet. `checked_version` is floored at
                    `reviewed_version`, so inequality means "ahead". */}
                {cliReview && !cliReview.unreviewed
                  && cliReview.checked_version !== cliReview.reviewed_version && (
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
                    <span>{`${cliReview.checked_version} checked and verified`}</span>
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
