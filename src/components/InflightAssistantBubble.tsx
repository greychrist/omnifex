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
 * Smoothing: the SDK delivers tokens in bursts. Rather than pacing
 * them out via a fake typewriter, we render the buffered text
 * directly and rely on two visual softeners — (a) a mask-image
 * gradient that fades the trailing edge of the prose so newly
 * arrived text materializes from translucent into opaque as more
 * text arrives below it, and (b) a brief opacity pulse on each
 * length change so each chunk's appearance feels intentional.
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
  // newly-revealed chars fade in from translucent to opaque as more text
  // arrives below them. The mask fades only the bottom ~1.2em (≈ one line of
  // prose-sm text), so older content stays fully opaque. Equivalent
  // -webkit-mask-image keeps Electron's Chromium happy on older releases.
  const trailingFadeStyle: React.CSSProperties = {
    maskImage:
      'linear-gradient(to bottom, black 0, black calc(100% - 1.2em), transparent 100%)',
    WebkitMaskImage:
      'linear-gradient(to bottom, black 0, black calc(100% - 1.2em), transparent 100%)',
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
              {/* Per-chunk fade: keying on text length re-mounts this
                  motion span on each coalescer flush, so the just-arrived
                  delta enters at opacity 0.5 and animates up to 1.0 in
                  120ms. Older content is already opaque on the second
                  arrival because it's the same key from a prior render's
                  perspective — but since the key changes every flush,
                  the whole content re-fades briefly. The duration is
                  short enough that the eye reads it as "the chunk arrived"
                  rather than "everything blinked". */}
              <motion.div
                key={text.length}
                initial={{ opacity: 0.55 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {text}
                </ReactMarkdown>
              </motion.div>
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
