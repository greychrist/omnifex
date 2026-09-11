import { cn } from '@/lib/utils';
import { formatTokens } from '@/lib/contextPressure';
import type { SessionSignal } from '@/lib/signals/types';

export interface SignalEventLogProps {
  events: SessionSignal[];
  className?: string;
}

const timeOf = (at: number) =>
  at > 0 ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

/**
 * The anchor's recent events, newest first.
 *
 * Mono and tabular throughout: the whole value of this list is scanning a
 * column of deltas for the one that is out of scale, which proportional digits
 * defeat. `before → after` is rendered inline rather than on hover because the
 * popover is already the "tell me more" surface — hiding it behind a second
 * interaction would make it unreachable by keyboard.
 */
export function SignalEventLog({ events, className }: SignalEventLogProps) {
  if (events.length === 0) {
    return (
      <div className={cn('text-xs text-muted-foreground italic', className)}>
        Nothing to report yet.
      </div>
    );
  }

  return (
    <ul className={cn('flex flex-col gap-0.5', className)}>
      {events.map((event) => {
        const meta = event.meta as
          | { delta?: number; before?: number; after?: number; compacted?: boolean; isJump?: boolean }
          | undefined;
        const hasDelta = typeof meta?.delta === 'number';

        return (
          <li
            key={event.id}
            className={cn(
              'flex items-baseline gap-2 rounded-sm px-1 py-0.5 text-[11px] font-mono tabular-nums',
              !event.read && 'bg-primary/5',
            )}
          >
            <span
              className={cn(
                'w-16 shrink-0 text-right',
                meta?.compacted
                  ? 'text-muted-foreground'
                  : meta?.isJump
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-foreground/80',
              )}
            >
              {meta?.compacted
                ? 'compacted'
                : hasDelta
                  ? `${meta.delta! >= 0 ? '+' : '−'}${formatTokens(Math.abs(meta.delta!))}`
                  : ''}
            </span>

            <span className="flex-1 min-w-0 truncate text-muted-foreground">
              {typeof meta?.before === 'number' && typeof meta.after === 'number'
                ? `${formatTokens(meta.before)} → ${formatTokens(meta.after)}`
                : (event.detail ?? event.title)}
            </span>

            <span className="shrink-0 text-muted-foreground/60">{timeOf(event.at)}</span>
          </li>
        );
      })}
    </ul>
  );
}
