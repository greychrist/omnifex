import * as React from 'react';
import { Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import { deriveThinkingStatus } from '@/lib/thinkingStatus';
import type { JsonlNode } from '@/types/jsonl';

interface ThinkingBarProps {
  /** The session transcript. Only its tail is read — see deriveThinkingStatus. */
  messages: JsonlNode[];
  /** True while the CLI owns the turn. Gates the stale-tail case below. */
  isLive: boolean;
  className?: string;
}

/**
 * Live readout of the current extended-thinking burst, pinned above the
 * transcript at the top of the content area. It started in the bottom bar
 * stack beside TaskList / SubagentBar and moved: while waiting on a reply the
 * eye is on the tail of the transcript, and the top edge is where a status
 * strip reads as "about what is below" rather than as part of the prompt.
 *
 * The CLI emits a `system:thinking_tokens` ping every few hundred tokens of
 * thinking. Rendered as transcript cards they stack a dozen near-identical
 * "~N thinking tokens" rows down a single deep-thinking turn; `messageFilters`
 * now collapses each burst to its final ping, and the running count lives here
 * instead — one artifact, at a fixed place on screen, that a scroll can't carry
 * away and that the streaming bubble can't suppress (unlike the typing-dots
 * activity row, which hides itself as soon as the bubble appears).
 *
 * Height is zero unless a burst is in flight, so it costs nothing the rest of
 * the time. The burst's end is implicit — the first non-system node terminates
 * it — so there is no turn-end signal to plumb and no way for the bar to get
 * stuck on mid-stream.
 *
 * `isLive` covers the one case the implicit ending cannot: an interrupted turn
 * leaves a `thinking_tokens` ping as the permanent tail of the transcript, and
 * without the gate the bar would go on claiming the session was thinking for as
 * long as the tab stayed open.
 */
export function ThinkingBar({ messages, isLive, className }: ThinkingBarProps) {
  const status = React.useMemo(() => deriveThinkingStatus(messages), [messages]);

  if (!isLive || status === null) return null;

  return (
    <div
      role="status"
      className={cn(
        'shrink-0 flex items-center gap-2 px-3 py-2 text-xs',
        'bg-violet-500/10 text-violet-600 dark:text-violet-400',
        className,
      )}
    >
      <Brain className="h-4 w-4 shrink-0 animate-pulse" aria-hidden="true" />
      <span className="flex-1">
        Thinking…{' '}
        {/* tabular-nums keeps the row from twitching as the count grows a
            digit — it updates every few hundred tokens. */}
        <span className="font-mono tabular-nums">{status.tokens.toLocaleString()}</span>{' '}
        <span className="text-muted-foreground">tokens</span>
      </span>
    </div>
  );
}
