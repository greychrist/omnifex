import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, CircleFadingArrowUp, Download, Loader2, CheckCircle, AlertCircle, HardDrive } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipSimple,
  TooltipTrigger,
} from '@/components/ui/tooltip-modern';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import OmniFexIcon from '../../icons/icon.png';
import { TabStatusPopover } from '@/components/TabStatusPopover';
import { fireAndLog } from "@/lib/fireAndLog";
// Minimum visible spin time on the upgrade-check button. Local checks can
// resolve in <100ms which makes the spinner flash and feels like nothing
// happened; holding for ~700ms gives clear feedback.
const MIN_CHECK_SPIN_MS = 700;

interface CustomTitlebarProps {
  onSettingsClick?: () => void;
  onLimaClick?: () => void;
}


export const CustomTitlebar: React.FC<CustomTitlebarProps> = ({
  onSettingsClick,
  onLimaClick,
}) => {
  const [appVersion, setAppVersion] = useState<string>('');

  // --- Update state ---
  type UpdateState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'up-to-date' }
    | { status: 'available'; version: string; downloadUrl: string; assetName: string; releaseUrl: string }
    | { status: 'downloading'; percent: number }
    | { status: 'ready'; filePath: string; version: string }
    | { status: 'waiting'; version: string; filePath: string; activeSessions: number }
    | { status: 'installing'; version: string }
    | { status: 'error'; downloadUrl: string; assetName: string; releaseUrl: string; version: string };
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });
  // Live count of sessions whose turn is in flight. Drives the upgrade
  // button's "active sessions" warning state — when an update is available
  // and this is > 0, clicking the button installs anyway (force=true).
  const [activeSessions, setActiveSessions] = useState<number>(0);
  useEffect(() => {
    return api.onSessionInFlightCount(setActiveSessions);
  }, []);

  // Reusable check-for-update function
  const checkForUpdate = useCallback(async () => {
     
    console.log('[updater] checkForUpdate() fired');
    setUpdateState({ status: 'checking' });
    try {
      const info = await api.checkForUpdate();
       
      console.log(`[updater] checkForUpdate() result available=${String(!!info?.available)}`);
      if (info?.available) {
        setUpdateState({
          status: 'available',
          version: info.version,
          downloadUrl: info.downloadUrl,
          assetName: info.assetName,
          releaseUrl: info.releaseUrl,
        });
      } else {
        // App is up to date — show the green badge briefly and auto-dismiss.
        setUpdateState({ status: 'up-to-date' });
      }
    } catch {
      setUpdateState({ status: 'idle' });
    }
  }, []);

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

  // One-click refresh for the upgrade-check button.
  const checkEverything = useCallback(() => {
    withMinSpin(checkForUpdate());
  }, [checkForUpdate, withMinSpin]);

  // Auto-dismiss the green "up-to-date" badge after a beat.
  useEffect(() => {
    if (updateState.status !== 'up-to-date') return;
    const t = setTimeout(() => {
      setUpdateState((prev) =>
        prev.status === 'up-to-date' ? { status: 'idle' } : prev,
      );
    }, 3000);
    return () => { clearTimeout(t); };
  }, [updateState.status]);

  // Fetch app version + check for updates on mount.
  useEffect(() => {
    api.getAppVersion().then(setAppVersion).catch(() => {});
    withMinSpin(checkForUpdate());

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
  }, [checkForUpdate, withMinSpin]);

  // One-click install. We keep download + install internal so the user only
  // ever sees one button press. `force` is wired to the live in-flight session
  // count so clicking the button while sessions are mid-turn calls stopAll()
  // on the main side and then installs.
  const runInstall = async (
    filePath: string,
    version: string,
    downloadUrl: string,
    assetName: string,
    releaseUrl: string,
  ): Promise<void> => {
    const force = activeSessions > 0;
     
    console.log(`[updater] runInstall force=${String(force)} activeSessions=${activeSessions}`);
    try {
      await api.installUpdate(filePath, version, force ? { force: true } : undefined);
      // executeInstall calls app.quit() on success — we never reach here.
      setUpdateState({ status: 'idle' });
    } catch (err: any) {
       
      console.log(`[updater] installUpdate failed message=${String((err?.message ?? err) as unknown)}`);
      setUpdateState({ status: 'error', downloadUrl, assetName, releaseUrl, version });
    }
  };

  const handleUpdateClick = async () => {
     
    console.log(`[updater] handleUpdateClick status=${updateState.status} active=${activeSessions}`);
    if (updateState.status === 'available') {
      const { downloadUrl, assetName, releaseUrl, version } = updateState;
      setUpdateState({ status: 'downloading', percent: 0 });
      let filePath: string;
      try {
        filePath = await api.downloadUpdate(downloadUrl, assetName);
      } catch (e: any) {

        console.log(`[updater] download failed message=${String((e?.message ?? e) as unknown)}`);
        setUpdateState({ status: 'error', downloadUrl, assetName, releaseUrl, version });
        return;
      }
      // Stop at 'ready' — the user must click the "Install Update" button to
      // proceed. We used to auto-install here, which (a) skipped past the
      // visible "Install Update" affordance and (b) made the wait-for-idle
      // gate unnecessarily eager when sessions were mid-turn.
      setUpdateState({ status: 'ready', filePath, version });
    } else if (updateState.status === 'ready') {
      const { filePath, version } = updateState;
      await runInstall(filePath, version, filePath, '', '');
    } else if (updateState.status === 'error') {
      // Retry: re-download. Install requires a second click on the resulting
      // "Install Update" button, same as the happy-path 'available' branch.
      const { downloadUrl, assetName, releaseUrl, version } = updateState;
      setUpdateState({ status: 'downloading', percent: 0 });
      let filePath: string;
      try {
        filePath = await api.downloadUpdate(downloadUrl, assetName);
      } catch {
        setUpdateState({ status: 'error', downloadUrl, assetName, releaseUrl, version });
        return;
      }
      setUpdateState({ status: 'ready', filePath, version });
    }
  };

  const handleInstallAnyway = async () => {
     
    console.log('[updater] handleInstallAnyway clicked', { status: updateState.status });
    if (updateState.status !== 'waiting') return;
    const { filePath, version } = updateState;
    try {
      await api.installUpdate(filePath, version, { force: true });
    } catch {
      setUpdateState({
        status: 'error',
        downloadUrl: filePath,
        assetName: '',
        releaseUrl: '',
        version,
      });
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

      {/* Right side - Navigation icons */}
      <div className="flex items-center pr-5 gap-2 app-no-drag">
        {/* Update button — visible during checking, when update available, downloading, ready, up-to-date, or error */}
        <AnimatePresence>
          {updateState.status !== 'idle' && (
            <TooltipSimple
              content={
                updateState.status === 'checking' ? 'Checking for updates...' :
                updateState.status === 'up-to-date' ? 'You\'re up to date' :
                updateState.status === 'available' ? `v${updateState.version} available` :
                updateState.status === 'downloading' ? 'Downloading...' :
                updateState.status === 'ready' ? `Install v${updateState.version}` :
                updateState.status === 'waiting' ? `Waiting for ${updateState.activeSessions} active session(s)` :
                updateState.status === 'installing' ? `Installing v${updateState.version}…` :
                'Retry download'
              }
              side="bottom"
            >
              {updateState.status === 'waiting' ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-600/20 text-amber-500 app-no-drag"
                >
                  <Loader2 size={13} className="animate-spin" />
                  <span>
                    Waiting for sessions… ({updateState.activeSessions} active)
                  </span>
                  <button
                    type="button"
                    onClick={fireAndLog('custom-titlebar:click', handleInstallAnyway)}
                    className="ml-1 px-1.5 py-0.5 rounded bg-destructive/80 text-destructive-foreground hover:bg-destructive text-[10px]"
                  >
                    Install anyway
                  </button>
                  <button
                    type="button"
                    onClick={fireAndLog('custom-titlebar:click', handleCancelInstall)}
                    className="px-1.5 py-0.5 rounded bg-muted hover:bg-muted/80 text-[10px]"
                  >
                    Cancel
                  </button>
                </motion.div>
              ) : (
                <motion.button
                  onClick={fireAndLog('custom-titlebar:click', handleUpdateClick)}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  whileTap={
                    updateState.status !== 'checking' &&
                    updateState.status !== 'up-to-date' &&
                    updateState.status !== 'installing'
                      ? { scale: 0.97 }
                      : undefined
                  }
                  transition={{ duration: 0.2 }}
                  disabled={updateState.status === 'installing'}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors app-no-drag ${
                    updateState.status === 'checking'
                      ? 'bg-muted text-muted-foreground cursor-wait'
                      : updateState.status === 'up-to-date'
                      ? 'bg-green-600/20 text-green-500 cursor-default'
                      : updateState.status === 'available' && activeSessions > 0
                      ? 'bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 border border-amber-500/40'
                      : updateState.status === 'available'
                      ? 'bg-primary text-primary-foreground animate-pulse hover:bg-primary/90'
                      : updateState.status === 'downloading'
                      ? 'bg-primary/80 text-primary-foreground cursor-wait'
                      // Same warning chrome as the 'available' + active case so
                      // the user sees "there are running sessions" BEFORE they
                      // click Install — not only after the install gate flips
                      // the button to 'waiting'.
                      : updateState.status === 'ready' && activeSessions > 0
                      ? 'bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 border border-amber-500/40'
                      : updateState.status === 'ready'
                      ? 'bg-green-600 text-white hover:bg-green-700'
                      : updateState.status === 'installing'
                      ? 'bg-green-600/80 text-white cursor-wait'
                      : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  }`}
                >
                  {updateState.status === 'checking' && <Loader2 size={13} className="animate-spin" />}
                  {updateState.status === 'up-to-date' && <CheckCircle size={13} />}
                  {updateState.status === 'available' && activeSessions > 0 && <AlertCircle size={13} />}
                  {updateState.status === 'available' && activeSessions === 0 && <Download size={13} />}
                  {updateState.status === 'downloading' && <Loader2 size={13} className="animate-spin" />}
                  {updateState.status === 'ready' && activeSessions > 0 && <AlertCircle size={13} />}
                  {updateState.status === 'ready' && activeSessions === 0 && <CheckCircle size={13} />}
                  {updateState.status === 'installing' && <Loader2 size={13} className="animate-spin" />}
                  {updateState.status === 'error' && <AlertCircle size={13} />}
                  <span>
                    {updateState.status === 'checking' && 'Checking...'}
                    {updateState.status === 'up-to-date' && 'Up to Date'}
                    {updateState.status === 'available' && activeSessions > 0 &&
                      `${activeSessions} active — Install Anyway`}
                    {updateState.status === 'available' && activeSessions === 0 && 'Update Available!'}
                    {updateState.status === 'downloading' && `${Math.round(updateState.percent)}%`}
                    {updateState.status === 'ready' && activeSessions > 0 &&
                      `${activeSessions} active — Install Anyway`}
                    {updateState.status === 'ready' && activeSessions === 0 && 'Install Update'}
                    {updateState.status === 'installing' && 'Installing…'}
                    {updateState.status === 'error' && 'Retry'}
                  </span>
                </motion.button>
              )}
            </TooltipSimple>
          )}
          </AnimatePresence>

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
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors app-no-drag"
            >
              <HardDrive size={16} />
              <span>Lima</span>
            </motion.button>
          )}

          <TabStatusPopover />

          {onSettingsClick && (
            <motion.button
              onClick={onSettingsClick}
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.15 }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground transition-colors app-no-drag"
            >
              <Settings size={16} />
              <span>Settings</span>
            </motion.button>
          )}

          {(() => {
            const isCheckingAnything = checkingHold || updateState.status === 'checking';
            return (
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild>
              <motion.button
                onClick={checkEverything}
                disabled={isCheckingAnything || updateState.status === 'downloading'}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed app-no-drag',
                  'hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <CircleFadingArrowUp
                  size={16}
                  className={isCheckingAnything ? 'animate-spin' : ''}
                />
                <span>Updates</span>
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" className="px-0 py-0 w-[240px]">
              <div className="px-3.5 py-2.5 border-b border-border/50 flex items-center justify-between">
                <span className="text-base font-semibold">
                  {isCheckingAnything ? 'Checking for upgrade…' : 'Check for Upgrade'}
                </span>
                {isCheckingAnything && (
                  <Loader2 size={14} className="animate-spin text-muted-foreground" />
                )}
              </div>
              <div className="px-3.5 py-2.5 space-y-2 text-[13px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">App</span>
                  <span className="font-medium">OmniFex {appVersion || '—'}</span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
            );
          })()}
          </div>
      </div>
    </div>
    </TooltipProvider>
  );
};
