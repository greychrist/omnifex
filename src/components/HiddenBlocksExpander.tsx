import React, { useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { useScrollAnchor } from '@/lib/useScrollAnchor';

interface Props {
  count: number;
  summary: string;
  children: React.ReactNode;
}

/**
 * Inline mini-expander placed inside a visible parent message card to wrap
 * that message's hidden content blocks (e.g. tool_use blocks under an
 * assistant text reply). Same Collapsible primitive as HiddenEventsGroup,
 * smaller chrome, scoped to one card.
 */
export const HiddenBlocksExpander: React.FC<Props> = ({ count, summary, children }) => {
  const [open, setOpen] = useState(false);
  const { ref: triggerRef, runWith } = useScrollAnchor<HTMLButtonElement>();
  if (count === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={(next) => { runWith(() => { setOpen(next); }); }} className="my-1">
      <CollapsibleTrigger
        ref={triggerRef}
        className={cn(
          'group flex w-full items-center justify-between gap-2 rounded',
          'px-2 py-1 text-left text-[11px]',
          'hover:bg-foreground/5 transition-colors',
          'data-[state=open]:bg-primary/10 data-[state=open]:ring-1 data-[state=open]:ring-primary/30',
        )}
      >
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="font-medium text-foreground/70 shrink-0">
            {count} hidden {count === 1 ? 'event' : 'events'}:
          </span>
          <span className="text-muted-foreground truncate">{summary || '…'}</span>
        </span>
        <ChevronsUpDown className="h-3 w-3 text-muted-foreground/60 shrink-0" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent
        className="mt-2 ml-1 pl-3 border-l-2 space-y-2"
        style={{ borderLeftColor: 'color-mix(in oklab, var(--color-foreground) 65%, transparent)' }}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};
