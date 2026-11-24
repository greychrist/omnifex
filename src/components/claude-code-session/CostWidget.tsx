import { DollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HeaderLabel } from '../HeaderLabel';

interface CostWidgetProps {
  costUsd: number | null;
  loading?: boolean;
  accountName?: string;
  onClick?: () => void;
  hideLabel?: boolean;
  estimated?: boolean;
  breakdown?: import('@/lib/api').SessionCostSnapshot | null;
  className?: string;
}

export function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

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
  // The icon carries the $.
  const pillValue = (v: number) => formatCost(v).slice(1);

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
          {estimated ? '~' : ''}{pillValue(costUsd)}
        </span>
      </button>
    </div>
  );
}
