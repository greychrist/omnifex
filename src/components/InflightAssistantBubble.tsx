import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { MessageFrame } from '@/components/StreamMessage/MessageFrame';
import { useTheme } from '@/hooks';
import { getClaudeSyntaxTheme } from '@/lib/claudeSyntaxTheme';
import { buildMarkdownComponents } from '@/lib/markdownComponents';

// Stable module-level reference, for the same reason as StreamMessage's copy:
// ReactMarkdown re-renders if `remarkPlugins` is a new array each call, which
// rebuilds the nested Prism-highlighted code DOM. This component re-renders on
// every flush of a streaming turn, so an inline literal here re-parsed the
// whole accumulated answer several times a second.
const REMARK_PLUGINS = [remarkGfm];

/**
 * Renders the in-flight assistant text from the inflight slot. Returns
 * null when the slot is empty — the only side effect is mounting /
 * unmounting based on slot presence.
 *
 * Once the complete assistant message lands, the IPC subscriber clears
 * the slot and the bubble unmounts, replaced by the canonical message
 * already appended into messages[] by the reducer.
 *
 * Subscribes via a narrow store selector so this component re-renders
 * only when the inflight slot changes — not on unrelated tab state
 * mutations (messages[] appends, account info refresh, etc.).
 *
 * No animation, no mask, no cursor: just the buffered text rendered
 * as ReactMarkdown. The bubble appears when streaming starts, grows
 * as deltas land, and disappears when the canonical message takes
 * its place. Honest representation of what's happening.
 *
 * It is a regular message of kind `assistant.text.live` ("Live reply", a
 * dashed amber card by default), rendered through MessageFrame so every
 * Appearance setting applies — presentation, alignment, colour, header. The text may or may not become the
 * turn's final answer — that is only known once the finished message lands
 * — so it looks provisional rather than borrowing a finished message's card.
 */
export const InflightAssistantBubble: React.FC<{ tabId: string }> = ({ tabId }) => {
  const inflight = useClaudeSessionStore(
    (s) => s.tabs[tabId]?.inflightAssistant ?? null,
  );
  const { theme } = useTheme();
  const syntaxTheme = useMemo(() => getClaudeSyntaxTheme(theme), [theme]);
  const mdComponents = useMemo(() => buildMarkdownComponents(syntaxTheme, { streaming: true }), [syntaxTheme]);

  if (!inflight?.text) return null;

  return (
    <div className="my-1">
      <MessageFrame streamKind="assistant.text.live">
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>
            {inflight.text}
          </ReactMarkdown>
        </div>
      </MessageFrame>
    </div>
  );
};
