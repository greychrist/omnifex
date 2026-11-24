import * as React from "react";
import { ReadoutLabel } from '@/components/ui/readout-label';
import { DatabaseZap } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  evaluateCacheExpiry,
  formatRemaining,
  CACHE_TTL_1H_MS,
} from "@/lib/cacheExpiry";

export interface CacheTimerRowProps {
  anchorMs: number | null;
  ttlMs: number | null;
  className?: string;
}

// Owns its one-second interval: ticking in AgentSession would re-render its whole tree every second.
export const CacheTimerRow: React.FC<CacheTimerRowProps> = ({
  anchorMs,
  ttlMs,
  className,
}) => {
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  const tracking = anchorMs !== null && ttlMs !== null;
  const expired = tracking && nowMs - anchorMs >= ttlMs;

  React.useEffect(() => {
    // Runs during a turn too: each model call rewrites the cache, so it can expire between calls.
    if (!tracking || expired) return;
    const id = setInterval(() => { setNowMs(Date.now()); }, 1000);
    return () => { clearInterval(id); };
  }, [tracking, expired]);

  React.useEffect(() => {
    setNowMs(Date.now());
  }, [anchorMs, ttlMs]);

  if (anchorMs === null || ttlMs === null) return null;

  const { level, remainingMs } = evaluateCacheExpiry({ anchorMs, ttlMs, nowMs });

  const ttlLabel = ttlMs === CACHE_TTL_1H_MS ? '1h' : '5m';
  const writtenAgo = formatRemaining(Math.max(0, nowMs - anchorMs));

  let text: string;
  let tone: string;
  if (level === 'expired') {
    text = `expired (${ttlLabel})`;
    tone = 'text-muted-foreground';
  } else {
    text = `${formatRemaining(remainingMs)} left (${ttlLabel})`;
    tone =
      level === 'critical'
        ? 'text-red-500'
        : level === 'warn'
          ? 'text-amber-500'
          : 'text-muted-foreground';
  }

  const title = level === 'expired'
    ? `${ttlLabel} prompt cache expired. The next turn pays a full re-read.`
    : `${ttlLabel} prompt cache, last written ${writtenAgo} ago. ${formatRemaining(remainingMs)} left.`;

  return (
    <span
      data-testid="cache-timer"
      title={title}
      className={cn("inline-flex items-center gap-1 px-2 text-[10px] font-mono truncate", tone, className)}
    >
      <DatabaseZap className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <ReadoutLabel>cache</ReadoutLabel>
      <span>{text}</span>
    </span>
  );
};
