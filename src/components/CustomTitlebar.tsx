import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, Info, MoreVertical, Download, Loader2, CheckCircle, AlertCircle, RefreshCw, HardDrive } from 'lucide-react';
import { TooltipProvider, TooltipSimple } from '@/components/ui/tooltip-modern';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import GreyChristIcon from '../../icons/icon.png';
const SDK_POLL_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

const BADGE_BASE_CLASS =
  'inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium select-none tauri-no-drag';
const BADGE_NEUTRAL_CLASS = 'bg-muted/40 text-muted-foreground border-border/60';
const BADGE_GREEN_CLASS = 'bg-green-500/15 text-green-500 border-green-500/30';
const BADGE_RED_CLASS = 'bg-red-500/15 text-red-500 border-red-500/30';

interface CustomTitlebarProps {
  onSettingsClick?: () => void;
  onLimaClick?: () => void;
  onInfoClick?: () => void;
}


export const CustomTitlebar: React.FC<CustomTitlebarProps> = ({
  onSettingsClick,
  onLimaClick,
  onInfoClick
}) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [appVersion, setAppVersion] = useState<string>('');
  const [referencedSdk, setReferencedSdk] = useState<string | null>(null);
  const [latestSdk, setLatestSdk] = useState<string | null>(null);
  // True while an SDK version fetch is in-flight. Starts true so the badge
  // shows its spinner on the very first paint, before the initial check has
  // had a chance to complete.
  const [checkingSdk, setCheckingSdk] = useState(true);

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
  // Live count of sessions whose SDK turn is in flight. Drives the upgrade
  // button's "active sessions" warning state — when an update is available
  // and this is > 0, clicking the button installs anyway (force=true).
  const [activeSessions, setActiveSessions] = useState<number>(0);
  useEffect(() => {
    return api.onSessionInFlightCount(setActiveSessions);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Reusable check-for-update function
  const checkForUpdate = useCallback(async () => {
    // eslint-disable-next-line no-console
    console.log('[updater] checkForUpdate() fired');
    setUpdateState({ status: 'checking' });
    try {
      const info = await api.checkForUpdate();
      // eslint-disable-next-line no-console
      console.log('[updater] checkForUpdate() result available=' + !!info?.available);
      if (info?.available) {
        setUpdateState({
          status: 'available',
          version: info.version,
          downloadUrl: info.downloadUrl,
          assetName: info.assetName,
          releaseUrl: info.releaseUrl,
        });
      } else {
        setUpdateState({ status: 'up-to-date' });
        // Auto-dismiss "up to date" after 3 seconds
        setTimeout(() => {
          setUpdateState((prev) => prev.status === 'up-to-date' ? { status: 'idle' } : prev);
        }, 3000);
      }
    } catch {
      setUpdateState({ status: 'idle' });
    }
  }, []);

  // Reusable SDK-version check. Flips `checkingSdk` so the badge can show a
  // spinner while the npm registry fetch is in flight, and updates
  // `latestSdk` with the result (or null on failure).
  const checkSdkVersion = useCallback(async () => {
    setCheckingSdk(true);
    try {
      const v = await api.getLatestSdkVersion();
      setLatestSdk(v);
    } catch {
      setLatestSdk(null);
    } finally {
      setCheckingSdk(false);
    }
  }, []);

  // Combined one-click refresh for the dropdown's "Check for Updates" button:
  // app update check AND SDK version check kick off in parallel.
  const checkEverything = useCallback(() => {
    void checkForUpdate();
    void checkSdkVersion();
  }, [checkForUpdate, checkSdkVersion]);

  // Fetch app version + check for updates + check SDK on mount
  useEffect(() => {
    api.getAppVersion().then(setAppVersion).catch(() => {});
    api.getReferencedSdkVersion().then(setReferencedSdk).catch(() => setReferencedSdk(null));
    void checkForUpdate();
    void checkSdkVersion();

    // Re-check the SDK hourly so the badge reflects new releases without a
    // restart. (The app-update check is manual only after mount.)
    const sdkTimer = setInterval(() => { void checkSdkVersion(); }, SDK_POLL_INTERVAL_MS);

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
      // eslint-disable-next-line no-console
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
      clearInterval(sdkTimer);
      cleanupProgress();
      cleanupInstallStatus();
    };
  }, [checkForUpdate, checkSdkVersion]);

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
    // eslint-disable-next-line no-console
    console.log('[updater] runInstall force=' + force + ' activeSessions=' + activeSessions);
    try {
      await api.installUpdate(filePath, version, force ? { force: true } : undefined);
      // executeInstall calls app.quit() on success — we never reach here.
      setUpdateState({ status: 'idle' });
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.log('[updater] installUpdate failed message=' + (err?.message ?? String(err)));
      setUpdateState({ status: 'error', downloadUrl, assetName, releaseUrl, version });
    }
  };

  const handleUpdateClick = async () => {
    // eslint-disable-next-line no-console
    console.log('[updater] handleUpdateClick status=' + updateState.status + ' active=' + activeSessions);
    if (updateState.status === 'available') {
      const { downloadUrl, assetName, releaseUrl, version } = updateState;
      setUpdateState({ status: 'downloading', percent: 0 });
      let filePath: string;
      try {
        filePath = await api.downloadUpdate(downloadUrl, assetName);
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.log('[updater] download failed message=' + (e?.message ?? String(e)));
        setUpdateState({ status: 'error', downloadUrl, assetName, releaseUrl, version });
        return;
      }
      setUpdateState({ status: 'ready', filePath, version });
      await runInstall(filePath, version, downloadUrl, assetName, releaseUrl);
    } else if (updateState.status === 'ready') {
      const { filePath, version } = updateState;
      await runInstall(filePath, version, filePath, '', '');
    } else if (updateState.status === 'error') {
      // Retry: re-download then install.
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
      await runInstall(filePath, version, downloadUrl, assetName, releaseUrl);
    }
  };

  const handleInstallAnyway = async () => {
    // eslint-disable-next-line no-console
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
      className="relative z-[200] h-[60px] bg-background/95 backdrop-blur-sm flex items-center justify-between select-none border-b border-border/50 tauri-drag"
      data-tauri-drag-region
    >
      {/* Left side - app icon + version badges. Traffic lights live in the
           OS-native title bar above this row, so no left padding needed. */}
      <div className="flex items-center pl-3 gap-1.5 tauri-no-drag">
        <img
          src={GreyChristIcon}
          alt="GreyChrist"
          className="h-12 w-12 rounded-md select-none mr-3"
          draggable={false}
        />
        {appVersion && (
          <TooltipSimple content="GreyChrist application version" side="bottom">
            <span className={cn(BADGE_BASE_CLASS, BADGE_NEUTRAL_CLASS)}>
              GreyChrist {appVersion}
            </span>
          </TooltipSimple>
        )}
        {referencedSdk && (
          <TooltipSimple content="SDK version this build is tied to" side="bottom">
            <span className={cn(BADGE_BASE_CLASS, BADGE_NEUTRAL_CLASS)}>
              Referenced SDK {referencedSdk}
            </span>
          </TooltipSimple>
        )}
        <TooltipSimple
          content={
            checkingSdk
              ? 'Checking npm for latest SDK version…'
              : latestSdk == null
                ? 'Latest SDK version unavailable'
                : referencedSdk && latestSdk === referencedSdk
                  ? 'SDK is up to date'
                  : `Newer SDK available on npm: ${latestSdk}`
          }
          side="bottom"
        >
          <span
            className={cn(
              BADGE_BASE_CLASS,
              'gap-1',
              // Default to green — only flip to red when we have a confirmed
              // mismatch against the referenced version.
              referencedSdk && latestSdk && latestSdk !== referencedSdk
                ? BADGE_RED_CLASS
                : BADGE_GREEN_CLASS,
            )}
          >
            <span>Current SDK</span>
            {checkingSdk
              ? <Loader2 size={10} className="animate-spin" />
              : <span>{latestSdk ?? '—'}</span>}
          </span>
        </TooltipSimple>
      </div>

      {/* Right side - Navigation icons */}
      <div className="flex items-center pr-5 gap-3 tauri-no-drag">
        {/* Primary actions group */}
        <div className="flex items-center gap-1">
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
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-600/20 text-amber-500 tauri-no-drag"
                >
                  <Loader2 size={13} className="animate-spin" />
                  <span>
                    Waiting for sessions… ({updateState.activeSessions} active)
                  </span>
                  <button
                    type="button"
                    onClick={handleInstallAnyway}
                    className="ml-1 px-1.5 py-0.5 rounded bg-destructive/80 text-destructive-foreground hover:bg-destructive text-[10px]"
                  >
                    Install anyway
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelInstall}
                    className="px-1.5 py-0.5 rounded bg-muted hover:bg-muted/80 text-[10px]"
                  >
                    Cancel
                  </button>
                </motion.div>
              ) : (
                <motion.button
                  onClick={handleUpdateClick}
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
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors tauri-no-drag ${
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
                  {updateState.status === 'ready' && <CheckCircle size={13} />}
                  {updateState.status === 'installing' && <Loader2 size={13} className="animate-spin" />}
                  {updateState.status === 'error' && <AlertCircle size={13} />}
                  <span>
                    {updateState.status === 'checking' && 'Checking...'}
                    {updateState.status === 'up-to-date' && 'Up to Date'}
                    {updateState.status === 'available' && activeSessions > 0 &&
                      `${activeSessions} active — Install Anyway`}
                    {updateState.status === 'available' && activeSessions === 0 && 'Update Available!'}
                    {updateState.status === 'downloading' && `${Math.round(updateState.percent)}%`}
                    {updateState.status === 'ready' && 'Install Update'}
                    {updateState.status === 'installing' && 'Installing…'}
                    {updateState.status === 'error' && 'Retry'}
                  </span>
                </motion.button>
              )}
            </TooltipSimple>
          )}
          </AnimatePresence>

          {onLimaClick && (
            <TooltipSimple content="Lima VMs" side="bottom">
              <motion.button
                onClick={onLimaClick}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className="p-2 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors tauri-no-drag"
              >
                <HardDrive size={16} />
              </motion.button>
            </TooltipSimple>
          )}

        </div>

        {/* Visual separator */}
        <div className="w-px h-5 bg-border/50" />

        {/* Secondary actions group */}
        <div className="flex items-center gap-1">
          {onSettingsClick && (
            <TooltipSimple content="Settings" side="bottom">
              <motion.button
                onClick={onSettingsClick}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className="p-2 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors tauri-no-drag"
              >
                <Settings size={16} />
              </motion.button>
            </TooltipSimple>
          )}

          {/* Dropdown menu for additional options */}
          <div className="relative" ref={dropdownRef}>
            <TooltipSimple content="More options" side="bottom">
              <motion.button
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className="p-2 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-1"
              >
                <MoreVertical size={16} />
              </motion.button>
            </TooltipSimple>

            {isDropdownOpen && (
              <div className="absolute right-0 mt-2 w-48 bg-popover border border-border rounded-lg shadow-lg z-[250]">
                <div className="py-1">
                  <button
                    onClick={() => {
                      checkEverything();
                      setIsDropdownOpen(false);
                    }}
                    disabled={updateState.status === 'checking' || updateState.status === 'downloading' || checkingSdk}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCw size={14} className={updateState.status === 'checking' || checkingSdk ? 'animate-spin' : ''} />
                    <span>{updateState.status === 'checking' || checkingSdk ? 'Checking...' : 'Check for Updates'}</span>
                  </button>

                  {onInfoClick && (
                    <button
                      onClick={() => {
                        onInfoClick();
                        setIsDropdownOpen(false);
                      }}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-3"
                    >
                      <Info size={14} />
                      <span>About</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
    </TooltipProvider>
  );
};
