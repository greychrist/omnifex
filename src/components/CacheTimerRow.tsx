import * as React from "react";
import { DatabaseZap } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  evaluateCacheExpiry,
  formatRemaining,
  CACHE_TTL_1H_MS,
} from "@/lib/cacheExpiry";

export interface CacheTimerRowProps {
  /** Newest assistant message's timestamp — when the TTL last restarted. */
  anchorMs: number | null;
  /** TTL the CLI actually used, observed from usage.cache_creation. */
  ttlMs: number | null;
  className?: string;
}

/**
 * Prompt-cache countdown, rendered in the chat status bar above the transcript.
 *
 * Owns its own one-second interval so the tick stays local: AgentSession is
 * large with a deep child tree, and ticking up there would re-render all of it
 * every second. The interval stops itself at expiry, and never starts when
 * there is nothing to count.
 *
 * See docs/superpowers/specs/2026-07-30-cache-expiry-timer-design.md
 */
export const CacheTimerRow: React.FC<CacheTimerRowProps> = ({
  anchorMs,
  ttlMs,
  className,
}) => {
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  const tracking = anchorMs !== null && ttlMs !== null;
  const expired = tracking && nowMs - anchorMs >= ttlMs;

  React.useEffect(() => {
    // Nothing to count: no observation yet, or already expired.
    //
    // It runs during a turn too. The cache is written by each model call, not
    // by the turn, and every call lands an assistant message that moves the
    // anchor — so between calls (a long tool run, a permission prompt left
    // waiting) the cache really is counting down, and can really expire. A
    // "refreshing" state used to cover the whole turn and hid exactly that.
    if (!tracking || expired) return;
    const id = setInterval(() => { setNowMs(Date.now()); }, 1000);
    return () => { clearInterval(id); };
  }, [tracking, expired]);

  // Re-sync the clock when a new turn moves the anchor, so the row doesn't wait
  // up to a second to show the refreshed countdown.
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
    text = `cache expired (${ttlLabel})`;
    tone = 'text-muted-foreground';
  } else {
    // TTL named inline, not just in the tooltip, so a 1h → 5m drop stays
    // legible after the one-off change notice has cleared.
    text = `cache ${formatRemaining(remainingMs)} left (${ttlLabel})`;
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
      title={title}
      className={cn("inline-flex items-center gap-1 px-2 text-[10px] font-mono truncate", tone, className)}
    >
      {/* A cache that is counting down to a rewrite: the database is the
          thing, the bolt is that it is live and expiring. */}
      <DatabaseZap className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {text}
    </span>
  );
};
