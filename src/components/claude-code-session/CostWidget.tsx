import { DollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HeaderLabel } from '../HeaderLabel';

interface CostWidgetProps {
  /** Session cost in USD from the scraped /usage output. Null = no data yet. */
  costUsd: number | null;
  /** A /usage refresh is in flight. */
  loading?: boolean;
  /** Account name shown in the tooltip. */
  accountName?: string;
  /** Click handler — parent typically opens the usage-detail popover. */
  onClick?: () => void;
  /** Hide the HeaderLabel above the badge. */
  hideLabel?: boolean;
  /** True when any priced message used an unknown-model estimate. */
  estimated?: boolean;
  /** Computed snapshot for the tooltip breakdown (null = scraped fallback). */
  breakdown?: import('@/lib/api').SessionCostSnapshot | null;
  className?: string;
}

/**
 * Format a USD cost for the compact pill. Sub-cent amounts keep four decimals
 * so a real-but-tiny cost doesn't collapse to a misleading "$0.00"; everything
 * else shows the familiar two-decimal currency form.
 */
export function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Compact cost pill for cost-based accounts (e.g. Enterprise / API), shown in
 * place of the rate-limit chart since those accounts are billed per token and
 * expose no subscription rate-limit windows. Mirrors {@link RateLimitWidget}'s
 * visual language (icon + value pill) so the two read as siblings.
 */
export function CostWidget({
  costUsd,
  loading,
  accountName,
  onClick,
  hideLabel,
  estimated,
  breakdown,
  className,
}: CostWidgetProps) {
  const label = 'Session cost';

  // No data yet — render the same muted placeholder shape as RateLimitWidget.
  if (costUsd == null) {
    return (
      <div className={cn('flex flex-col items-start gap-0.5', className)}>
        {!hideLabel && <HeaderLabel>{label}</HeaderLabel>}
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium text-muted-foreground/70',
            'bg-background/50 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_25%,transparent)]',
            loading && 'animate-pulse',
          )}
          title={accountName ? `${accountName} · no ${label.toLowerCase()} data yet` : `no ${label.toLowerCase()} data yet`}
        >
          <DollarSign className="w-3.5 h-3.5 opacity-60" />
          <span className="opacity-60 text-right tabular-nums min-w-[5ch]">—</span>
        </span>
      </div>
    );
  }

  const tooltip = [
    accountName ? `${accountName} · ${label}` : label,
    `${estimated ? '~' : ''}${formatCost(costUsd)}`,
    ...(breakdown
      ? [
          `input ${formatCost(breakdown.breakdown.inputUsd)} · output ${formatCost(breakdown.breakdown.outputUsd)}`,
          `cache read ${formatCost(breakdown.breakdown.cacheReadUsd)} · cache write ${formatCost(breakdown.breakdown.cacheWriteUsd)}`,
          breakdown.subagentUsd > 0 ? `subagents ${formatCost(breakdown.subagentUsd)}` : '',
          'computed from session transcript tokens',
        ]
      : ['billed per token — no rate-limit windows on this account']),
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
          loading && 'opacity-60',
        )}
      >
        <DollarSign className="w-3.5 h-3.5 text-foreground" />
        <span className="font-mono text-right tabular-nums min-w-[5ch]">
          {estimated ? '~' : ''}{formatCost(costUsd)}
        </span>
      </button>
    </div>
  );
}
