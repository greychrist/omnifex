import * as React from 'react';
import { CircleCheckBig, CircleAlert, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

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
}) => {
  const [busy, setBusy] = React.useState(false);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onReconnect();
    } finally {
      setBusy(false);
    }
  };

  const hasErrors = errors.length > 0;
  const title = busy
    ? 'Reconnecting…'
    : hasErrors
      ? `Git status errors:\n${errors.map((e) => `  • ${e.label}: ${e.error}`).join('\n')}\n\nClick to reconnect.`
      : 'Watching git status — click to refresh';

  const Icon = busy ? Loader2 : hasErrors ? CircleAlert : CircleCheckBig;
  const color = hasErrors ? 'text-rose-400' : 'text-emerald-400';

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex items-center justify-center h-5 w-5 rounded transition-colors',
        'hover:bg-foreground/10 disabled:cursor-not-allowed',
        color,
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', busy && 'animate-spin text-muted-foreground')} />
    </button>
  );
};
