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
 * cursor toward `inflight.text.length` at a strict, constant rate
 * (one char per TYPEWRITER_INTERVAL_MS), independent of how full
 * the buffer is. The buffer absorbs SDK bursts; the typewriter
 * paces them out for the eye.
 *
 * Note: the plan referenced `<MarkdownBlock content={...} />`, but this
 * repo's `MarkdownBlock` is a fenced-block primitive with a
 * Rendered/Source toggle and takes `source`, not `content`. Streaming
 * assistant text is rendered via `ReactMarkdown` + the shared
 * `buildMarkdownComponents` dispatcher (see `StreamMessage.tsx`), so
 * we mirror that pattern here.
 */

/** Milliseconds between revealed characters. Strict one-char-at-a-time
 *  pacing — the rate is constant regardless of how full the buffer is.
 *  10ms ≈ 100 chars/sec, fast but still smooth per-char. Lower →
 *  faster, higher → slower. The typewriter can fall behind a fast SDK
 *  burst; if the canonical assistant message lands before the
 *  typewriter catches up, Task 7's reconciliation clears the slot and
 *  the bubble snaps to the full canonical message. */
const TYPEWRITER_INTERVAL_MS = 10;

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

  // Stash the live target length in a ref so the interval (set up once)
  // always sees the latest value without re-binding the timer.
  const targetLengthRef = useRef(targetLength);
  targetLengthRef.current = targetLength;

  // Clamp on any backward jump in target (defensive: shouldn't happen,
  // but if a future code path replaces text instead of appending, the
  // cursor must not point past the end of the string).
  useEffect(() => {
    setDisplayedLength((cur) => Math.min(cur, targetLength));
  }, [targetLength]);

  // Strict one-char-per-tick typewriter. The interval runs for the
  // bubble's whole lifetime; when caught up, the setState call returns
  // the same value and React bails out — no re-render, near-zero cost.
  useEffect(() => {
    const id = setInterval(() => {
      setDisplayedLength((cur) => {
        const t = targetLengthRef.current;
        return cur < t ? cur + 1 : cur;
      });
    }, TYPEWRITER_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  if (!inflight || !targetText) return null;

  const displayedText = targetText.slice(0, displayedLength);
  const isCatchingUp = displayedLength < targetLength;

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

  return (
    <Card className={cn('group/card relative my-1 border-border/40')}>
      <CardContent
        className="prose prose-sm dark:prose-invert max-w-none py-2 px-3"
        style={trailingFadeStyle}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {displayedText}
        </ReactMarkdown>
        <span
          aria-hidden
          className={cn(
            'text-muted-foreground inline-block ml-0.5',
            // Hold the cursor solid while text is still flowing in — the
            // fade-in tail already conveys "live". Only pulse once the
            // typewriter has caught up to the buffer (i.e., the SDK has
            // stopped sending deltas for now), as a steady-state idle hint.
            !isCatchingUp && 'animate-pulse',
          )}
        >
          |
        </span>
      </CardContent>
    </Card>
  );
};
