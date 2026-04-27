import * as React from 'react';
import { Clock, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RateLimitSnapshot } from '@/lib/api';
import { HeaderLabel } from '../SessionHeader';

interface RateLimitWidgetProps {
  /** Latest snapshot for this rate-limit window. Null = no data yet. */
  snapshot: RateLimitSnapshot | null;
  /** Which window this widget represents — drives label, icon, fallback copy. */
  windowType: 'five_hour' | 'seven_day';
  /** Account name displayed in tooltip. */
  accountName?: string;
  /** Click handler — parent typically routes to UsageDashboard. */
  onClick?: () => void;
  /** Wall-clock right now (ms since epoch). Defaults to `Date.now()`. */
  nowMs?: number;
  className?: string;
}

const STALE_MS = 10 * 60 * 1000; // 10 min

const LABELS: Record<RateLimitWidgetProps['windowType'], { label: string; short: string }> = {
  five_hour: { label: 'Current session', short: '5h' },
  seven_day: { label: 'Current week', short: '7d' },
};

const ICONS: Record<RateLimitWidgetProps['windowType'], React.ComponentType<{ className?: string }>> = {
  five_hour: Clock,
  seven_day: CalendarDays,
};

function formatResetTail(resetsAt: number | null, nowMs: number): string {
  if (resetsAt == null) return '';
  const remainingMs = resetsAt * 1000 - nowMs;
  if (remainingMs <= 0) return 'now';
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  return `${days}d ${hrs}h`;
}

/**
 * Compact pill that mirrors the SessionHeader context widget's visual
 * language (icon, value, gradient mini-bar, percentage). Renders the
 * authoritative rate-limit utilization for one window (5-hour or 7-day).
 */
export function RateLimitWidget({
  snapshot,
  windowType,
  accountName,
  onClick,
  nowMs,
  className,
}: RateLimitWidgetProps) {
  const { label } = LABELS[windowType];
  const Icon = ICONS[windowType];
  const now = nowMs ?? Date.now();

  // Empty state — no data yet for this window
  if (!snapshot) {
    return (
      <div className={cn('flex flex-col items-start gap-0.5', className)}>
        <HeaderLabel>{label}</HeaderLabel>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium text-muted-foreground/70',
            'bg-background/50 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_25%,transparent)]',
          )}
          title={accountName ? `${accountName} · no ${label} data yet` : `no ${label} data yet`}
        >
          <Icon className="w-3.5 h-3.5 opacity-60" />
          <span className="opacity-60">—</span>
          <div className="w-16 h-1.5 bg-foreground/10 rounded-full" />
          <span className="opacity-60">--</span>
        </span>
      </div>
    );
  }

  const pct = snapshot.utilization == null ? null : Math.max(0, Math.min(100, snapshot.utilization));
  const ageMs = now - snapshot.observed_at;
  const isStale = ageMs > STALE_MS;
  const isRejected = snapshot.status === 'rejected';
  const isWarning = snapshot.status === 'allowed_warning';
  const tail = formatResetTail(snapshot.resets_at, now);

  // Color the percentage label by severity. Bar is always the gradient.
  const pctTextColor =
    isRejected
      ? 'text-red-500'
      : pct == null
        ? 'text-foreground'
        : pct >= 90
          ? 'text-red-400'
          : pct >= 75
            ? 'text-orange-400'
            : pct >= 50
              ? 'text-yellow-400'
              : 'text-foreground';

  const tooltip = [
    accountName ? `${accountName} · ${label}` : label,
    `status: ${snapshot.status}`,
    pct != null ? `${pct.toFixed(1)}%` : 'utilization unknown',
    snapshot.resets_at ? `resets at ${new Date(snapshot.resets_at * 1000).toLocaleString()}` : null,
    `last seen ${new Date(snapshot.observed_at).toLocaleTimeString()}`,
    isStale ? `(stale — ${Math.floor(ageMs / 60_000)}m old)` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className={cn('flex flex-col items-start gap-0.5', className)}>
      <HeaderLabel>{label}</HeaderLabel>
      <button
        type="button"
        onClick={onClick}
        title={tooltip}
        className={cn(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium cursor-pointer text-foreground',
          'bg-background shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isStale && 'opacity-60',
          isRejected && 'shadow-[0_0_0_1px_rgb(239_68_68_/_0.7)]',
          isWarning && !isRejected && 'shadow-[0_0_0_1px_rgb(251_146_60_/_0.7)]',
        )}
      >
        <Icon className={cn('w-3.5 h-3.5', isRejected ? 'text-red-400' : 'text-foreground')} />
        <span className={cn('font-mono', pctTextColor)}>
          {pct != null ? `${pct.toFixed(0)}%` : '?%'}
        </span>
        <div className="w-16 h-1.5 bg-foreground/10 rounded-full overflow-hidden relative">
          <div
            className="absolute inset-0 rounded-full bg-gradient-to-r from-green-400 via-orange-400 to-red-400 transition-[clip-path]"
            style={{ clipPath: `inset(0 ${pct == null ? 100 : 100 - pct}% 0 0)` }}
          />
        </div>
        <span className="text-foreground/70 font-mono whitespace-nowrap">
          {tail || '—'}
        </span>
        {isStale && (
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground ml-0.5">
            stale
          </span>
        )}
      </button>
    </div>
  );
}
