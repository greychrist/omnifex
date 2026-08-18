import * as React from 'react';
import { Hourglass } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UsageLimitBannerProps {
  /**
   * Epoch-SECONDS reset time from `usageLimitWait(messages)`, or null when the
   * session isn't parked on a limit (in which case this renders nothing).
   */
  resetsAt: number | null;
  /** Wall-clock right now (ms since epoch). Defaults to `Date.now()`. */
  nowMs?: number;
  className?: string;
}

/** How often the countdown re-renders while the banner is up. */
const TICK_MS = 30_000;

function formatRemaining(resetsAt: number, nowMs: number): string {
  const remainingMs = resetsAt * 1000 - nowMs;
  if (remainingMs <= 0) return 'any moment now';
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `in ${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

/**
 * Explains a session that is in flight but not doing anything.
 *
 * Claude Code 2.1.234 added `autoContinueAtUsageLimit`, on by default for
 * claude.ai logins: hitting a usage limit no longer ends the turn, it parks it
 * until the limit resets. `waitingOnClaude` stays true across that wait and is
 * right to — the CLI genuinely still owns the turn — so the composer spins,
 * potentially for hours, with nothing on screen accounting for it.
 *
 * Deliberately worded as an observation ("waiting for the reset") rather than
 * a promise ("will continue automatically"). Auto-continue is a CLI-side
 * setting we cannot read from here, and if the user has turned it off the CLI
 * is showing its own limit dialog instead — the wait is what's true either way.
 */
export function UsageLimitBanner({ resetsAt, nowMs, className }: UsageLimitBannerProps) {
  // Self-ticks only when the caller didn't pin the clock, so the countdown
  // stays honest during a multi-hour park without the caller re-rendering the
  // whole session on a timer. Tests pass `nowMs` and get a static render.
  const pinned = nowMs !== undefined;
  const [tick, setTick] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (pinned || resetsAt === null) return;
    const id = setInterval(() => setTick(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [pinned, resetsAt]);

  if (resetsAt === null) return null;

  const now = nowMs ?? tick;
  const clock = new Date(resetsAt * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div
      role="status"
      className={cn(
        'shrink-0 flex items-center gap-2 px-3 py-2 text-xs',
        'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        className,
      )}
    >
      <Hourglass className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">
        Usage limit reached — waiting for the reset at{' '}
        <span className="font-mono tabular-nums">{clock}</span>{' '}
        <span className="text-muted-foreground">({formatRemaining(resetsAt, now)})</span>
      </span>
    </div>
  );
}
