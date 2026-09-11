import * as React from 'react';
import { AlertOctagon, AlertTriangle, ChevronLeft, ChevronRight, PlugZap, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SessionSignal, SignalAnchor } from '@/lib/signals/types';

export interface AttentionSlotProps {
  /** The tab's attention queue, already sorted by the store. */
  queue: SessionSignal[];
  /** Remove an item from the slot. It stays in its anchored popover. */
  onDismiss: (key: string) => void;
  className?: string;
}

const ANCHOR_ICON: Record<SignalAnchor, React.ComponentType<{ className?: string }>> = {
  session: AlertOctagon,
  account: AlertTriangle,
  branch: AlertTriangle,
  agents: AlertTriangle,
  mcp: PlugZap,
};

/**
 * The one slot in the app allowed to interrupt: a single call to action,
 * directly above the subagents bar.
 *
 * This replaces a stack that had grown to five banners. The rule that keeps it
 * from growing back is that it renders **exactly one item, ever** — overflow is
 * a `1 of N` counter, not another row. Everything informational was routed to a
 * widget badge instead and never reaches here.
 *
 * Returns `null` rather than an empty wrapper when idle. It sits in the flex
 * column above the composer, where a zero-content div still contributes its
 * padding and pushes the transcript.
 */
export function AttentionSlot({ queue, onDismiss, className }: AttentionSlotProps) {
  const [cursor, setCursor] = React.useState(0);

  // Resolving the item under the cursor shortens the queue beneath it; without
  // the clamp the slot points past the end and renders nothing while items are
  // still waiting.
  const index = queue.length === 0 ? 0 : Math.min(cursor, queue.length - 1);

  React.useEffect(() => {
    if (cursor > 0 && cursor >= queue.length) setCursor(Math.max(0, queue.length - 1));
  }, [cursor, queue.length]);

  if (queue.length === 0) return null;

  const item = queue[index];
  const Icon = ANCHOR_ICON[item.anchor];
  const critical = item.priority === 'high';
  const step = (delta: number) => {
    setCursor((c) => {
      const from = Math.min(c, queue.length - 1);
      return (from + delta + queue.length) % queue.length;
    });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        // py-1 matches SubagentBar's collapsed row so the two read as one
        // group rather than as two bars of different weights.
        'shrink-0 flex items-center gap-2 px-3 py-1 text-[11px]',
        critical
          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
          : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />

      <div className="flex-1 min-w-0">
        <span className="font-medium">{item.title}</span>
        {item.detail && <span className="ml-2 opacity-80">{item.detail}</span>}
      </div>

      {item.actions?.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={action.disabled}
          onClick={() => void action.run()}
          className={cn(
            'shrink-0 rounded-sm px-2 py-0.5 transition-colors',
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

      {queue.length > 1 && (
        <div className="flex shrink-0 items-center gap-0.5 pl-1 opacity-70">
          <button
            type="button"
            aria-label="Previous attention item"
            onClick={() => { step(-1); }}
            className="rounded-sm p-0.5 hover:bg-current/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <span className="font-mono tabular-nums">
            {index + 1} of {queue.length}
          </span>
          <button
            type="button"
            aria-label="Next attention item"
            onClick={() => { step(1); }}
            className="rounded-sm p-0.5 hover:bg-current/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      )}

      <button
        type="button"
        aria-label={`Dismiss: ${item.title}`}
        title="Dismiss — stays available in the widget it belongs to"
        onClick={() => { onDismiss(item.key); }}
        className="shrink-0 opacity-60 hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
