import { cn } from '@/lib/utils';
import { formatTokens } from '@/lib/contextPressure';
import type { SessionSignal } from '@/lib/signals/types';

export interface SignalEventLogProps {
  events: SessionSignal[];
  className?: string;
  onSelect?: (messageUuid: string) => void;
}

const timeOf = (at: number) =>
  at > 0 ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

export function SignalEventLog({ events, className, onSelect }: SignalEventLogProps) {
  if (events.length === 0) {
    return (
      <div className={cn('text-xs text-muted-foreground italic', className)}>
        Nothing to report yet.
      </div>
    );
  }

  return (
    // Bounded height: a long session fills POPOVER_EVENT_LIMIT and would push the popover's controls below the fold.
    <ul
      className={cn(
        'flex flex-col gap-0.5 max-h-[200px] overflow-y-auto overscroll-contain',
        className,
      )}
    >
      {events.map((event) => {
        const meta = event.meta as
          | { delta?: number; before?: number; after?: number; compacted?: boolean; isJump?: boolean }
          | undefined;
        const delta = typeof meta?.delta === 'number' ? meta.delta : undefined;
        const target = onSelect && event.messageUuid ? event.messageUuid : null;
        const rowClass = cn(
          'flex w-full items-baseline gap-2 rounded-sm px-1 py-0.5 text-left text-[11px] font-mono tabular-nums',
          !event.read && 'bg-primary/5',
          target && 'cursor-pointer hover:bg-muted/60',
        );
        const cells = (
          <>
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
                : delta !== undefined
                  ? `${delta >= 0 ? '+' : '−'}${formatTokens(Math.abs(delta))}`
                  : ''}
            </span>

            <span className="flex-1 min-w-0 truncate text-muted-foreground">
              {typeof meta?.before === 'number' && typeof meta.after === 'number'
                ? `${formatTokens(meta.before)} → ${formatTokens(meta.after)}`
                : (event.detail ?? event.title)}
            </span>

            <span className="shrink-0 text-muted-foreground/60">{timeOf(event.at)}</span>
          </>
        );

        return (
          <li key={event.id}>
            {target ? (
              <button
                type="button"
                aria-label={`Jump to ${event.title}`}
                title="Show in the chat"
                onClick={() => { onSelect?.(target); }}
                className={rowClass}
              >
                {cells}
              </button>
            ) : (
              <div className={rowClass}>{cells}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
