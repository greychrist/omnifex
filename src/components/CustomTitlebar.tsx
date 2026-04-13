import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, Bot, BarChart3, FileText, Network, Info, MoreVertical, Download, Loader2, CheckCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { TooltipProvider, TooltipSimple } from '@/components/ui/tooltip-modern';
import { api } from '@/lib/api';

interface CustomTitlebarProps {
  onSettingsClick?: () => void;
  onAgentsClick?: () => void;
  onUsageClick?: () => void;
  onClaudeClick?: () => void;
  onMCPClick?: () => void;
  onInfoClick?: () => void;
}

export const CustomTitlebar: React.FC<CustomTitlebarProps> = ({
  onSettingsClick,
  onAgentsClick,
  onUsageClick,
  onClaudeClick,
  onMCPClick,
  onInfoClick
}) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [appVersion, setAppVersion] = useState<string>('');

  // --- Update state ---
  type UpdateState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'up-to-date' }
    | { status: 'available'; version: string; downloadUrl: string; assetName: string; releaseUrl: string }
    | { status: 'downloading'; percent: number }
    | { status: 'ready'; filePath: string; version: string }
    | { status: 'error'; downloadUrl: string; assetName: string; releaseUrl: string };
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });

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
    setUpdateState({ status: 'checking' });
    try {
      const info = await api.checkForUpdate();
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

  // Fetch app version + check for updates on mount
  useEffect(() => {
    api.getAppVersion().then(setAppVersion).catch(() => {});
    checkForUpdate();

    // Listen for download progress
    const cleanup = api.onUpdateProgress((data: { percent: number }) => {
      setUpdateState((prev) =>
        prev.status === 'downloading' ? { ...prev, percent: data.percent } : prev,
      );
    });
    return cleanup;
  }, [checkForUpdate]);

  const handleUpdateClick = async () => {
    if (updateState.status === 'available') {
      const { downloadUrl, assetName, releaseUrl, version } = updateState;
      setUpdateState({ status: 'downloading', percent: 0 });
      try {
        const filePath = await api.downloadUpdate(downloadUrl, assetName);
        setUpdateState({ status: 'ready', filePath, version });
      } catch {
        setUpdateState({ status: 'error', downloadUrl, assetName, releaseUrl });
      }
    } else if (updateState.status === 'ready') {
      await api.openUpdate(updateState.filePath);
    } else if (updateState.status === 'error') {
      const { downloadUrl, assetName, releaseUrl } = updateState;
      setUpdateState({ status: 'downloading', percent: 0 });
      try {
        const filePath = await api.downloadUpdate(downloadUrl, assetName);
        setUpdateState({ status: 'ready', filePath, version: '' });
      } catch {
        setUpdateState({ status: 'error', downloadUrl, assetName, releaseUrl });
      }
    }
  };

  return (
    <TooltipProvider>
    <div
      className="relative z-[200] h-11 bg-background/95 backdrop-blur-sm flex items-center justify-between select-none border-b border-border/50 tauri-drag"
      data-tauri-drag-region
    >
      {/* Left side - version label (native traffic lights are provided by Electron frame) */}
      <div className="flex items-center pl-20">
        {appVersion && (
          <span className="text-[11px] text-muted-foreground/50 font-mono select-none">
            v{appVersion}
          </span>
        )}
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
                'Retry download'
              }
              side="bottom"
            >
              <motion.button
                onClick={handleUpdateClick}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                whileTap={updateState.status !== 'checking' && updateState.status !== 'up-to-date' ? { scale: 0.97 } : undefined}
                transition={{ duration: 0.2 }}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors tauri-no-drag ${
                  updateState.status === 'checking'
                    ? 'bg-muted text-muted-foreground cursor-wait'
                    : updateState.status === 'up-to-date'
                    ? 'bg-green-600/20 text-green-500 cursor-default'
                    : updateState.status === 'available'
                    ? 'bg-primary text-primary-foreground animate-pulse hover:bg-primary/90'
                    : updateState.status === 'downloading'
                    ? 'bg-primary/80 text-primary-foreground cursor-wait'
                    : updateState.status === 'ready'
                    ? 'bg-green-600 text-white hover:bg-green-700'
                    : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                }`}
              >
                {updateState.status === 'checking' && <Loader2 size={13} className="animate-spin" />}
                {updateState.status === 'up-to-date' && <CheckCircle size={13} />}
                {updateState.status === 'available' && <Download size={13} />}
                {updateState.status === 'downloading' && <Loader2 size={13} className="animate-spin" />}
                {updateState.status === 'ready' && <CheckCircle size={13} />}
                {updateState.status === 'error' && <AlertCircle size={13} />}
                <span>
                  {updateState.status === 'checking' && 'Checking...'}
                  {updateState.status === 'up-to-date' && 'Up to Date'}
                  {updateState.status === 'available' && 'Update Available!'}
                  {updateState.status === 'downloading' && `${Math.round(updateState.percent)}%`}
                  {updateState.status === 'ready' && 'Install Update'}
                  {updateState.status === 'error' && 'Retry'}
                </span>
              </motion.button>
            </TooltipSimple>
          )}
          </AnimatePresence>

          {onAgentsClick && (
            <TooltipSimple content="Agents" side="bottom">
              <motion.button
                onClick={onAgentsClick}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className="p-2 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors tauri-no-drag"
              >
                <Bot size={16} />
              </motion.button>
            </TooltipSimple>
          )}
          
          {onUsageClick && (
            <TooltipSimple content="Usage Dashboard" side="bottom">
              <motion.button
                onClick={onUsageClick}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className="p-2 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors tauri-no-drag"
              >
                <BarChart3 size={16} />
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
                  {onClaudeClick && (
                    <button
                      onClick={() => {
                        onClaudeClick();
                        setIsDropdownOpen(false);
                      }}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-3"
                    >
                      <FileText size={14} />
                      <span>CLAUDE.md</span>
                    </button>
                  )}
                  
                  {onMCPClick && (
                    <button
                      onClick={() => {
                        onMCPClick();
                        setIsDropdownOpen(false);
                      }}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-3"
                    >
                      <Network size={14} />
                      <span>MCP Servers</span>
                    </button>
                  )}
                  
                  <button
                    onClick={() => {
                      checkForUpdate();
                      setIsDropdownOpen(false);
                    }}
                    disabled={updateState.status === 'checking' || updateState.status === 'downloading'}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCw size={14} className={updateState.status === 'checking' ? 'animate-spin' : ''} />
                    <span>{updateState.status === 'checking' ? 'Checking...' : 'Check for Updates'}</span>
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
