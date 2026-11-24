import * as React from 'react';
import { RefreshCw, CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { fireAndLog } from "@/lib/fireAndLog";

interface GitWatchStatusIconProps {
  errors: { label: string; error: string }[];
  onReconnect: () => Promise<unknown>;
  snapshotKey?: unknown;
}

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
    const t = setTimeout(() => { setAutoPulse(false); }, 500);
    return () => { clearTimeout(t); };
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
      onClick={fireAndLog('git-watch-status-icon:click', handleClick)}
      disabled={userBusy}
      title={title}
      aria-label={title}
      className={cn('h-5 w-5 p-0 rounded-sm border-0 bg-transparent shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]', color)}
    >
      <Icon className={cn('h-3.5 w-3.5', spinning && 'animate-spin')} />
    </Button>
  );
};
