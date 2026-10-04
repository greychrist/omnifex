import React, { useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { StreamMessage } from './StreamMessage';
import { TranscriptRowBoundary } from '@/components/claude/TranscriptRowBoundary';
import { summarizeHiddenEvents, countHiddenEvents } from '@/lib/hiddenEventsSummary';
import { useScrollAnchor } from '@/lib/useScrollAnchor';
import { currentThemeBackdrop, hiddenEventsColors } from '@/lib/accentStyle';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import type { JsonlNode } from '@/types/jsonl';

interface Props {
  messages: JsonlNode[];
  streamMessages: JsonlNode[];
  /** Owning tab — forwarded so nested tool rows can read live tool progress. */
  tabId: string;
  accountType?: string;
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
  tabId,
  accountType,
  onResend,
}) => {
  const [open, setOpen] = useState(false);
  const { config } = useMessageRenderingConfig();
  const colors = hiddenEventsColors(config.hiddenEvents, currentThemeBackdrop());
  // The bar is the card's header: the background fills the header, the
  // border outlines the whole card. Inline, because the unlayered
  // `* { border-color }` in styles.css beats every border-color utility.
  const background = colors.bar?.backgroundColor;
  const borderColor = colors.bar?.borderColor;
  const { ref: triggerRef, runWith } = useScrollAnchor<HTMLButtonElement>();
  const count = countHiddenEvents(messages);
  const summary = summarizeHiddenEvents(messages);

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => { runWith(() => { setOpen(next); }); }}
      data-hidden-events-card=""
      className="my-1 overflow-hidden rounded-md border"
      style={borderColor ? { borderColor } : undefined}
    >
      <CollapsibleTrigger
        ref={triggerRef}
        className={cn(
          'group flex w-full items-center justify-between gap-3',
          'bg-muted/20 px-3 py-1.5 text-left',
          'hover:bg-muted/40 transition-colors',
          'data-[state=open]:bg-primary/10',
          // A configured background is inline and outranks the hover/open
          // fills above, so feedback comes from brightness instead.
          background && 'hover:brightness-125 data-[state=open]:brightness-125',
        )}
        style={background ? { backgroundColor: background } : undefined}
      >
        <span className="flex items-baseline gap-2 min-w-0 text-xs">
          <span className="font-medium text-foreground/80 shrink-0" style={colors.header ? { color: colors.header } : undefined}>
            {count} Hidden {count === 1 ? 'Event' : 'Events'}:
          </span>
          <span className="text-muted-foreground truncate" style={colors.detail ? { color: colors.detail } : undefined}>
            {summary || '…'}
          </span>
        </span>
        <ChevronsUpDown
          className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0 transition-transform group-data-[state=open]:opacity-100"
          style={colors.detail ? { color: colors.detail } : undefined}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        data-hidden-events-body=""
        className="border-t bg-black/10 py-3 pl-6 pr-3 space-y-4"
        style={borderColor ? { borderTopColor: borderColor } : undefined}
      >
        {messages.map((message, idx) => (
          <TranscriptRowBoundary key={idx}>
            <StreamMessage
              message={message}
              streamMessages={streamMessages}
              tabId={tabId}
              accountType={accountType}
              onResend={onResend}
              inExpandedGroup
            />
          </TranscriptRowBoundary>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
};
