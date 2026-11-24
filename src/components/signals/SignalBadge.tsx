import { cn } from '@/lib/utils';

export interface SignalBadgeProps {
  count: number;
  label: string;
  className?: string;
}

/** Absolutely positioned so it never reflows the resizable header; the host must be `relative`. */
export function SignalBadge({ count, label, className }: SignalBadgeProps) {
  if (count <= 0) return null;

  return (
    <span
      aria-label={`${count} unread ${label} ${count === 1 ? 'event' : 'events'}`}
      className={cn(
        'pointer-events-none absolute -top-1 -right-1 z-10',
        'inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1',
        'bg-primary text-primary-foreground',
        'text-[9px] font-semibold leading-none tabular-nums',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
