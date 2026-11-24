import * as React from 'react';
import { Clock, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RateLimitSnapshot } from '@/lib/api';
import { HeaderLabel } from '../HeaderLabel';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { InlineDivider } from '@/components/ui/inline-divider';

interface RateLimitWidgetProps {
  snapshot: RateLimitSnapshot | null;
  windowType: 'five_hour' | 'seven_day';
  accountName?: string;
  onClick?: () => void;
  nowMs?: number;
  hideLabel?: boolean;
  className?: string;
}

const STALE_MS = 10 * 60 * 1000;

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

export function rateLimitPctColor(pct: number | null, rejected: boolean): string {
  if (rejected) return 'text-red-500';
  if (pct == null) return 'text-foreground';
  if (pct >= 90) return 'text-red-400';
  if (pct >= 75) return 'text-orange-400';
  if (pct >= 50) return 'text-yellow-400';
  return 'text-foreground';
}

// Not from yellow: that starts at 50%, so a weekly window would pulse all week.
export function rateLimitPctAlert(pct: number | null, rejected: boolean): boolean {
  return rateLimitPctColor(pct, rejected).startsWith('text-red-');
}

export function RateLimitWidget({
  snapshot,
  windowType,
  accountName,
  onClick,
  nowMs,
  hideLabel,
  className,
}: RateLimitWidgetProps) {
  const { narrow } = useLayoutMode();
  const { label } = LABELS[windowType];
  const Icon = ICONS[windowType];
  const now = nowMs ?? Date.now();

  if (!snapshot) {
    return (
      <div className={cn('flex flex-col items-start gap-0.5', className)}>
        {!hideLabel && <HeaderLabel>{label}</HeaderLabel>}
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium text-muted-foreground/70',
            'bg-background/50 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_25%,transparent)]',
          )}
          title={accountName ? `${accountName} · no ${label} data yet` : `no ${label} data yet`}
        >
          <Icon className="w-3.5 h-3.5 opacity-60" />
          <span className="opacity-60 text-right tabular-nums min-w-[4ch]">—</span>
          {narrow
            ? <InlineDivider data-testid="rate-limit-divider" className="bg-current opacity-30" />
            : <div data-testid="rate-limit-bar" className="w-11 h-1.5 bg-foreground/10 rounded-full" />}
          <span className="opacity-60 text-left tabular-nums min-w-[7ch]">--</span>
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

  const pctTextColor = rateLimitPctColor(pct, isRejected);

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
      {!hideLabel && <HeaderLabel>{label}</HeaderLabel>}
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
        <span className={cn('font-mono text-right tabular-nums min-w-[4ch]', pctTextColor)}>
          {pct != null ? `${pct.toFixed(0)}%` : '?%'}
        </span>
        {/* Narrow drops the bar, but something must still keep the percentage off the reset countdown. */}
        {narrow ? (
          <InlineDivider data-testid="rate-limit-divider" className="bg-current opacity-30" />
        ) : (
          <div data-testid="rate-limit-bar" className="w-11 h-1.5 bg-foreground/10 rounded-full overflow-hidden relative">
            <div
              className="absolute inset-0 rounded-full bg-gradient-to-r from-green-400 via-orange-400 to-red-400 transition-[clip-path]"
              style={{ clipPath: `inset(0 ${pct == null ? 100 : 100 - pct}% 0 0)` }}
            />
          </div>
        )}
        <span className="text-foreground/70 font-mono whitespace-nowrap text-left tabular-nums min-w-[7ch]">
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
