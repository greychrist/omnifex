import { cn } from '@/lib/utils';

export interface SignalBadgeProps {
  count: number;
  /** Names the widget in the aria-label: "3 unread session events". */
  label: string;
  className?: string;
}

/**
 * Unread-event count for one anchor, pinned to the corner of its widget.
 *
 * Absolutely positioned so it never changes the widget's footprint — the
 * session header is user-resizable and a badge that reflowed it would undo the
 * user's layout every time a turn ended. The host must therefore be
 * `relative`.
 *
 * Renders nothing at zero, so the common case costs no DOM.
 */
export function SignalBadge({ count, label, className }: SignalBadgeProps) {
  if (count <= 0) return null;

  return (
    <span
      // The count is decoration for sighted users, who read it as a number;
      // the label is what makes it meaningful to a screen reader.
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
