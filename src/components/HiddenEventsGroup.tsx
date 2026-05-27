import React, { useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { StreamMessage } from './StreamMessage';
import { summarizeHiddenEvents, countHiddenEvents } from '@/lib/hiddenEventsSummary';
import { useScrollAnchor } from '@/lib/useScrollAnchor';
import type { JsonlNode } from '@/types/jsonl';

interface Props {
  messages: JsonlNode[];
  streamMessages: JsonlNode[];
  accountType?: string;
  onLinkDetected?: (url: string) => void;
  onResend?: (text: string, images?: string[]) => void;
}

/**
 * Outer compact-mode expander. Wraps a run of consecutive hidden messages
 * with a one-line summary. Click the trigger to reveal every wrapped
 * message rendered flat (no inner expanders — opening this expander is
 * "show me everything you hid here").
 */
export const HiddenEventsGroup: React.FC<Props> = ({
  messages,
  streamMessages,
  accountType,
  onLinkDetected,
  onResend,
}) => {
  const [open, setOpen] = useState(false);
  const { ref: triggerRef, runWith } = useScrollAnchor<HTMLButtonElement>();
  const count = countHiddenEvents(messages);
  const summary = summarizeHiddenEvents(messages);
  if (count === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={(next) => { runWith(() => { setOpen(next); }); }} className="py-1">
      <CollapsibleTrigger
        ref={triggerRef}
        className={cn(
          'group flex w-full items-center justify-between gap-3 rounded-md',
          'border border-border/40 bg-muted/20 px-3 py-1.5 text-left',
          'hover:bg-muted/40 transition-colors',
          'data-[state=open]:bg-primary/10 data-[state=open]:border-primary/40',
        )}
      >
        <span className="flex items-baseline gap-2 min-w-0 text-xs">
          <span className="font-medium text-foreground/80 shrink-0">
            {count} Hidden {count === 1 ? 'Event' : 'Events'}:
          </span>
          <span className="text-muted-foreground truncate">
            {summary || '…'}
          </span>
        </span>
        <ChevronsUpDown
          className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0 transition-transform group-data-[state=open]:opacity-100"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className="mt-2 ml-1 pl-4 border-l-2 space-y-4"
        style={{ borderLeftColor: 'color-mix(in oklab, var(--color-foreground) 65%, transparent)' }}
      >
        {messages.map((message, idx) => (
          <StreamMessage
            key={idx}
            message={message}
            streamMessages={streamMessages}
            accountType={accountType}
            onLinkDetected={onLinkDetected}
            onResend={onResend}
            inExpandedGroup
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
};
