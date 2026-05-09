import React, { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
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
 * Smoothing: the SDK delivers tokens in bursts. We render the
 * buffered text directly and rely on a mask-image gradient that
 * fades the trailing edge of the prose, so newly arrived text
 * materializes from translucent at the bottom and rises into full
 * opacity as more text arrives below it. ReactMarkdown can't be
 * cleanly split mid-stream (a `**foo` chunk would render its
 * delimiters literally if separated from a later `bar**`), so we
 * don't try to fade only the appended segment — geometry does the
 * work via the gradient instead.
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

  const text = inflight?.text ?? '';
  const isVisible = !!inflight && !!text;

  // Mask-image gradient — softens the trailing edge of the visible text so
  // newly-arrived chunks fade in from translucent at the bottom and rise
  // into opaque as more text arrives below them. The fade zone is ~2.5em
  // (about two lines of prose-sm text) plus a soft mid-zone, so chunk
  // arrivals slide through several stops of opacity rather than slamming
  // in at full opacity. Older content stays fully opaque above the zone.
  // Equivalent -webkit-mask-image keeps Electron's Chromium happy on
  // older releases.
  const trailingFadeStyle: React.CSSProperties = {
    maskImage:
      'linear-gradient(to bottom, black 0, black calc(100% - 2.5em), rgba(0,0,0,0.4) calc(100% - 1em), transparent 100%)',
    WebkitMaskImage:
      'linear-gradient(to bottom, black 0, black calc(100% - 2.5em), rgba(0,0,0,0.4) calc(100% - 1em), transparent 100%)',
  };

  // AnimatePresence + motion.div: when the slot clears (Task 7's reconcile
  // path on assistant complete / error / unmount), the conditional below
  // becomes false and framer-motion holds the previously-rendered DOM
  // frozen while running the exit fade. The canonical assistant message
  // has already mounted in the message list above us at the moment of
  // clear, so what the user sees is: full canonical bubble appears →
  // partial bubble below it dissolves over ~180ms. Reads as "the
  // streaming caught up and settled" instead of a hard snap.
  // initial={false} suppresses the entrance animation — the bubble appears
  // instantly with whatever first-flush content the coalescer delivered.
  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          key="inflight-bubble"
          initial={false}
          exit={{ opacity: 0, transition: { duration: 0.18, ease: 'easeOut' } }}
        >
          <Card className={cn('group/card relative my-1 border-border/40')}>
            <CardContent
              className="prose prose-sm dark:prose-invert max-w-none py-2 px-3"
              style={trailingFadeStyle}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {text}
              </ReactMarkdown>
              <span
                aria-hidden
                className="animate-pulse text-muted-foreground inline-block ml-0.5"
              >
                |
              </span>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
