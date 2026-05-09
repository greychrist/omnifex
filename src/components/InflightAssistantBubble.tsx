import React, { useEffect, useMemo, useRef, useState } from 'react';
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
 * Smoothing: the SDK delivers token bursts (a chunk of N chars per
 * delta), so painting `inflight.text` directly produces a chunky
 * stair-step animation. We instead advance a `displayedLength`
 * cursor toward `inflight.text.length` on requestAnimationFrame,
 * catching up within ~CATCHUP_FRAMES frames regardless of burst
 * size. Result: smooth typewriter-style growth at frame rate.
 *
 * Note: the plan referenced `<MarkdownBlock content={...} />`, but this
 * repo's `MarkdownBlock` is a fenced-block primitive with a
 * Rendered/Source toggle and takes `source`, not `content`. Streaming
 * assistant text is rendered via `ReactMarkdown` + the shared
 * `buildMarkdownComponents` dispatcher (see `StreamMessage.tsx`), so
 * we mirror that pattern here.
 */

/** Number of frames the typewriter takes to drain the buffer. With a
 *  60Hz display this is ~130ms — fast enough that the cursor stays
 *  near the most recently received text, slow enough to feel smooth. */
const CATCHUP_FRAMES = 8;

/** Floor on chars-per-frame so very small buffers still advance every
 *  frame instead of stalling on integer-rounded zero. */
const MIN_CHARS_PER_FRAME = 1;

export const InflightAssistantBubble: React.FC<{ tabId: string }> = ({ tabId }) => {
  const inflight = useClaudeSessionStore(
    (s) => s.tabs[tabId]?.inflightAssistant ?? null,
  );
  const { theme } = useTheme();
  const syntaxTheme = useMemo(() => getClaudeSyntaxTheme(theme), [theme]);
  const mdComponents = useMemo(() => buildMarkdownComponents(syntaxTheme), [syntaxTheme]);

  const targetText = inflight?.text ?? '';
  const targetLength = targetText.length;
  const [displayedLength, setDisplayedLength] = useState(0);
  const rafRef = useRef<number | null>(null);

  // Clamp on any backward jump in target (defensive: shouldn't happen,
  // but if a future code path replaces text instead of appending, the
  // cursor must not point past the end of the string).
  useEffect(() => {
    setDisplayedLength((cur) => Math.min(cur, targetLength));
  }, [targetLength]);

  // Animation loop: advance displayedLength toward targetLength.
  // The tick recursively schedules its next frame, so this effect
  // re-runs only when targetLength changes (not every tick).
  useEffect(() => {
    function tick() {
      rafRef.current = null;
      setDisplayedLength((cur) => {
        if (cur >= targetLength) return cur;
        const remaining = targetLength - cur;
        const advance = Math.max(
          MIN_CHARS_PER_FRAME,
          Math.ceil(remaining / CATCHUP_FRAMES),
        );
        const next = Math.min(cur + advance, targetLength);
        if (next < targetLength) {
          rafRef.current = requestAnimationFrame(tick);
        }
        return next;
      });
    }
    if (rafRef.current === null && displayedLength < targetLength) {
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [targetLength, displayedLength]);

  if (!inflight || !targetText) return null;

  const displayedText = targetText.slice(0, displayedLength);
  return (
    <Card className={cn('group/card relative my-1 border-border/40')}>
      <CardContent className="prose prose-sm dark:prose-invert max-w-none py-2 px-3">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {displayedText}
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
