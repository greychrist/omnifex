import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useTheme } from '@/hooks';
import { getClaudeSyntaxTheme } from '@/lib/claudeSyntaxTheme';
import { buildMarkdownComponents } from '@/lib/markdownComponents';

/**
 * Renders the in-flight assistant text from the inflight slot, with a
 * blinking cursor at the end. Returns null when the slot is empty —
 * the only side effect is mounting/unmounting based on slot presence.
 *
 * Once the complete assistant message lands, the subscriber clears the
 * slot and the bubble unmounts, replaced by the canonical message
 * already appended into messages[] by the reducer.
 *
 * Subscribes via a narrow store selector so this component re-renders
 * ONLY when the inflight slot changes — not on unrelated tab state
 * mutations (messages[] appends, account info refresh, etc.).
 *
 * Note: the plan referenced `<MarkdownBlock content={...} />`, but this
 * repo's `MarkdownBlock` is a fenced-block primitive with a
 * Rendered/Source toggle and takes `source`, not `content`. Streaming
 * assistant text is rendered via `ReactMarkdown` + the shared
 * `buildMarkdownComponents` dispatcher (see `StreamMessage.tsx`), so
 * we mirror that pattern here.
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
    <Card className={cn('group/card relative my-1 border-border/40')}>
      <CardContent className="prose prose-sm dark:prose-invert max-w-none py-2 px-3">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {inflight.text}
        </ReactMarkdown>
        <span
          aria-hidden
          className="animate-pulse text-muted-foreground inline-block ml-0.5"
        >
          |
        </span>
      </CardContent>
    </Card>
  );
};
