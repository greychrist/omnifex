import { AlertOctagon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SessionSignal } from '@/lib/signals/types';

export interface SignalActionCardProps {
  signal: SessionSignal;
  className?: string;
}

/**
 * A pending `action`, mirrored into its anchored widget's popover.
 *
 * This is what makes the attention slot's dismiss button safe. The slot can be
 * waved away because the item is never actually gone — it keeps standing here,
 * under the widget it is about, until the condition that raised it ends. The
 * old context-pressure banner had to be non-dismissible for exactly the lack of
 * this surface.
 */
export function SignalActionCard({ signal, className }: SignalActionCardProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-md px-2 py-1.5',
        signal.priority === 'high'
          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
          : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertOctagon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">{signal.title}</div>
          {signal.detail && (
            <div className="font-mono text-[10px] opacity-80">{signal.detail}</div>
          )}
        </div>
      </div>

      {signal.actions && signal.actions.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-5">
          {signal.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled}
              onClick={() => void action.run()}
              className={cn(
                'rounded-sm px-2 py-0.5 text-[11px] transition-colors',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                'disabled:opacity-40 disabled:cursor-default',
                action.primary
                  ? 'bg-current/15 font-medium hover:bg-current/25'
                  : 'hover:bg-current/10',
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
