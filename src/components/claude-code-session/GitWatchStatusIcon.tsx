import * as React from 'react';
import { RefreshCw, CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface GitWatchStatusIconProps {
  /**
   * Per-path errors aggregated from the unified session-git snapshot.
   * Empty = the whole watch is healthy. Each entry's `label` is what shows
   * in the tooltip (e.g. branch name, "project", or path basename).
   */
  errors: Array<{ label: string; error: string }>;
  /**
   * Trigger a reconnect for the whole tab's watch. Resolves once the main
   * process has re-armed the watch and emitted a fresh snapshot. The icon
   * owns its own spinner state for the duration of this call.
   */
  onReconnect: () => Promise<unknown>;
  /**
   * Reference identity changes when a fresh snapshot arrives from the
   * watcher. Drives a brief auto-spin so the user can see when a poll/fs
   * event actually delivered new data.
   */
  snapshotKey?: unknown;
}

/**
 * Click-to-reconnect status icon for the tab's unified git watch. One per
 * tab — green when every path in the snapshot reads cleanly, red when any
 * path reports an error, spinner while a reconnect attempt is in flight.
 * The tooltip lists the offending paths so the user can see at a glance
 * which worktree is wedged.
 */
export const GitWatchStatusIcon: React.FC<GitWatchStatusIconProps> = ({
  errors,
  onReconnect,
  snapshotKey,
}) => {
  const [userBusy, setUserBusy] = React.useState(false);
  const [autoPulse, setAutoPulse] = React.useState(false);

  const handleClick = async () => {
    if (userBusy) return;
    setUserBusy(true);
    const minSpin = new Promise((r) => setTimeout(r, 500));
    try {
      await Promise.all([onReconnect(), minSpin]);
    } finally {
      setUserBusy(false);
    }
  };

  // Pulse the spinner briefly each time a fresh snapshot arrives. Skip the
  // initial mount so we don't spin against the seed snapshot.
  const lastKey = React.useRef(snapshotKey);
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!seeded.current) {
      seeded.current = true;
      lastKey.current = snapshotKey;
      return;
    }
    if (lastKey.current === snapshotKey) return;
    lastKey.current = snapshotKey;
    setAutoPulse(true);
    const t = setTimeout(() => setAutoPulse(false), 500);
    return () => clearTimeout(t);
  }, [snapshotKey]);

  const spinning = userBusy || autoPulse;
  const hasErrors = errors.length > 0;
  const title = userBusy
    ? 'Reconnecting…'
    : hasErrors
      ? `Git status errors:\n${errors.map((e) => `  • ${e.label}: ${e.error}`).join('\n')}\n\nClick to reconnect.`
      : 'Watching git status — click to refresh';

  const Icon = hasErrors ? CircleAlert : RefreshCw;
  const color = hasErrors ? 'text-rose-400' : undefined;

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={handleClick}
      disabled={userBusy}
      title={title}
      aria-label={title}
      className={cn('h-5 w-5 p-0 rounded-sm border-0 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]', color)}
    >
      <Icon className={cn('h-3.5 w-3.5', spinning && 'animate-spin')} />
    </Button>
  );
};
