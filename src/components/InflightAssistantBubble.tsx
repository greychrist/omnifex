import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { Card, CardContent } from '@/components/ui/card';
import { useTheme } from '@/hooks';
import { getClaudeSyntaxTheme } from '@/lib/claudeSyntaxTheme';
import { buildMarkdownComponents } from '@/lib/markdownComponents';

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
 */
export const InflightAssistantBubble: React.FC<{ tabId: string }> = ({ tabId }) => {
  const inflight = useClaudeSessionStore(
    (s) => s.tabs[tabId]?.inflightAssistant ?? null,
  );
  const { theme } = useTheme();
  const syntaxTheme = useMemo(() => getClaudeSyntaxTheme(theme), [theme]);
  const mdComponents = useMemo(() => buildMarkdownComponents(syntaxTheme), [syntaxTheme]);

  if (!inflight || !inflight.text) return null;

  return (
    <Card className="group/card relative my-1 border-border/40">
      <CardContent className="prose prose-sm dark:prose-invert max-w-none py-2 px-3">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {inflight.text}
        </ReactMarkdown>
      </CardContent>
    </Card>
  );
};
