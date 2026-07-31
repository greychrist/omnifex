import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipSimple } from "@/components/ui/tooltip-modern";
import { StreamMessage } from "@/components/StreamMessage";
import { HiddenEventsGroup } from "@/components/HiddenEventsGroup";
import { InflightAssistantBubble } from "@/components/InflightAssistantBubble";
import { FindBar } from "@/components/FindBar";
import { useFindInChat } from "@/hooks/useFindInChat";
import { buildCompactItems } from "@/lib/compactGrouping";
import { filterDisplayableMessages } from "@/lib/messageFilters";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { useAutoScroll } from "@/contexts/AutoScrollContext";
import { useSessionGauges } from "@/contexts/SessionGaugesContext";
import { buildContextTimeline } from "@/lib/contextTimeline";
import { ContextTimelineTick } from "@/components/ContextTimelineTick";
import { ContextTimelineToggle } from "@/components/ContextTimelineToggle";
import { nextNearBottom } from "@/lib/autoScrollThresholds";
import { stepTarget, isStepStop, isMainPrompt, type StepDirection } from "@/lib/transcriptStepper";
import { cn } from "@/lib/utils";
import type { JsonlNode } from "@/types/jsonl";
import type { ViewMode } from "@/components/SessionViewToggle";

/** Shared chrome for the floating scroll/step buttons on the right edge. */
const NAV_BUTTON =
  "h-8 w-8 hover:bg-accent/50 transition-colors bg-background/80 backdrop-blur-sm border border-border/50";

export interface ClaudeTranscriptProps {
  /** All stream messages for this tab — passed to StreamMessage as the streamMessages context. */
  messages: JsonlNode[];
  /** Verbose vs. compact rendering mode. */
  viewMode: ViewMode;
  /** Resolved account type, used by StreamMessage for account-specific UI. */
  accountType: string | undefined;
  /** Stable resend callback (memoized in the shell). */
  onResend: (text: string, images: string[] | undefined) => void;
  /** Called when a URL is detected inside a rendered message. */
  onLinkDetected: (url: string) => void;
  /** True while a permission prompt is open — forces scroll-to-bottom so the prompt is visible. */
  waitingForPermission: boolean;
  /** Whether the turn is in flight (mainTurn || tasks). Renders the typing-dots bubble. */
  outstandingWork: boolean;
  /** True when the inflight streaming bubble is visible — suppresses the typing-dots row. */
  hasInflightAssistant: boolean;
  /** Activity gerund / label shown alongside the typing-dots bubble. */
  currentActivity: string;
  /** Running token total used in the typing-dots row. */
  totalTokens: number;
  /** Context window for this session — scales the timeline rail's bars. */
  contextLimit: number;
  /** Error string to render under the transcript, if any. */
  error: string | null;
  /** Tab id forwarded to InflightAssistantBubble. */
  tabId: string;
  /**
   * Ref to the sentinel below the last message. The shell uses this from
   * its session-history loader to snap to the bottom after a resume.
   */
  messagesEndRef: React.RefObject<HTMLDivElement>;
  /**
   * Mutable flag tracking whether the user is currently near the bottom of
   * the transcript. The shell flips this true when sending a new prompt so
   * the view re-engages stickiness even if the user had scrolled up.
   */
  isNearBottomRef: React.MutableRefObject<boolean>;
}

/**
 * Claude transcript — the body of the chat. Renders all messages, the
 * streaming bubble, the typing-dots row, and an inline error card. Owns
 * the find-in-chat bar and the scroll machinery (stick-to-bottom logic,
 * the scroll/step navigation buttons, resize observer).
 *
 * Extracted from `ClaudeCodeSession` (now `AgentSession`) so the agent
 * shell can swap Claude vs. Codex transcripts without duplicating chrome.
 */
export function ClaudeTranscript({
  messages,
  viewMode,
  accountType,
  onResend,
  onLinkDetected,
  waitingForPermission,
  outstandingWork,
  hasInflightAssistant,
  currentActivity,
  totalTokens,
  contextLimit,
  error,
  tabId,
  messagesEndRef,
  isNearBottomRef,
}: ClaudeTranscriptProps): React.ReactElement {
  const { config: renderConfig } = useMessageRenderingConfig();
  const { reengagePx, disengagePx } = useAutoScroll();
  const { contextTimelineEnabled, setContextTimelineEnabled, contextJump, contextPressure } =
    useSessionGauges();

  // Built over the FULL message array and keyed by node identity, so hard
  // filters can hide rows without shifting the series or corrupting deltas.
  const timeline = useMemo(
    () =>
      contextTimelineEnabled
        ? buildContextTimeline(messages, {
            limit: contextLimit,
            jumpThresholdTokens: contextJump.thresholdTokens,
            // Only the thresholds are borrowed. `contextPressure.enabled`
            // gates the banner; the rail answers to its own toggle, so
            // turning the banner off must not flatten the rail to green.
            pressure: contextPressure,
          })
        : null,
    [
      contextTimelineEnabled,
      messages,
      contextLimit,
      contextJump.thresholdTokens,
      contextPressure,
    ],
  );

  /**
   * Wraps a rendered row in the rail gutter when the timeline is on.
   *
   * The row spacing moves INSIDE the row (`pb-4` on the message column) rather
   * than staying on the container as `space-y-4`. With the gap between rows,
   * each rail segment stopped at its own row's edge and the series rendered as
   * a dashed ladder; with the gap inside, the gutter cell stretches through it
   * and consecutive rails meet. Messages keep the same visual separation.
   */
  const withTimeline = (node: JsonlNode | undefined, body: React.ReactNode) => {
    if (!timeline) return body;
    return (
      <div className="flex gap-2">
        <ContextTimelineTick point={node ? timeline.get(node) : undefined} />
        <div className="flex-1 min-w-0 pb-4">{body}</div>
      </div>
    );
  };

  // Filter out messages that shouldn't be displayed (honors the user's
  // hard-filter toggles in Appearance settings).
  const displayableMessages = useMemo(
    () => filterDisplayableMessages(messages, renderConfig.hardFilters),
    [messages, renderConfig.hardFilters],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  // Find-in-chat state. Cmd/Ctrl+F opens the floating FindBar; `useFindInChat`
  // walks `contentRef` (the messages list, not the scroll wrapper) and wraps
  // matches in <mark data-find>. transcriptVersion bumps on each new message
  // so highlights stay fresh while streaming. See FindBar.tsx +
  // useFindInChat.ts + docs/superpowers/specs/2026-05-11-find-in-chat-design.md.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');

  // Auto-scroll to bottom when new messages arrive, but only if already near the bottom.
  // Always scroll when waiting for permission so the user sees the latest context.
  // Uses `behavior: 'auto'` (instant) during streaming — smooth scroll lags behind
  // rapid CLI message bursts and gets visually "stuck" mid-scroll.
  useEffect(() => {
    if (displayableMessages.length > 0 && (isNearBottomRef.current || waitingForPermission)) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      });
    }
  }, [displayableMessages.length, waitingForPermission, isNearBottomRef, messagesEndRef]);

  // Second-order auto-scroll: watch the message-list container for height changes
  // that don't coincide with a new message arriving. Without this, rendering a
  // large code block, a syntax-highlighted diff, or a lazy-loading image pushes
  // content below the viewport AFTER the length-change effect already fired, and
  // the chat looks "stuck" a few hundred pixels above the real bottom.
  const contentRef = useRef<HTMLDivElement>(null);

  // Cmd/Ctrl+F → open the find bar. Esc inside the bar closes it (handled by
  // FindBar itself). Listener is scoped to window because focus may be on
  // the FloatingPromptInput when the user wants to find — we want the
  // shortcut to work regardless. Bound only while the session is mounted.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); };
  }, []);

  const findResults = useFindInChat({
    containerRef: contentRef,
    query: findQuery,
    isOpen: findOpen,
    // Messages array grows on every stream tick; using `.length` as the
    // version keeps the highlight count fresh without needing a separate
    // counter. A wholesale-reload would also bump it.
    transcriptVersion: messages.length,
  });

  useEffect(() => {
    const contentEl = contentRef.current;
    const scrollEl = parentRef.current;
    if (!contentEl || !scrollEl || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current || waitingForPermission) {
        // Direct scrollTop assignment — cheaper than scrollIntoView and doesn't
        // fight the smooth-scroll animation the length-change effect may have
        // just kicked off in the same frame.
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });
    observer.observe(contentEl);
    return () => { observer.disconnect(); };
  }, [waitingForPermission, isNearBottomRef]);

  /**
   * Where the last navigation button aimed, held until the smooth scroll has
   * had time to land. Smooth scrolling is asynchronous, so a second press
   * arrives while `scrollTop` still reads the old position — without this,
   * pressing "next" three times quickly advances one row, not three.
   */
  const pendingTargetRef = useRef<number | null>(null);

  const scrollToPosition = useCallback((top: number) => {
    const el = parentRef.current;
    if (!el) return;
    pendingTargetRef.current = top;
    el.scrollTo({ top, behavior: 'smooth' });
    // Released on a timer rather than on arrival: grabbing the scrollbar
    // mid-animation cancels the scroll, and a cancelled scroll fires no
    // "arrived" event to hook. 400ms is past the browser's smooth-scroll
    // duration, so a held-down button never outruns it.
    window.setTimeout(() => {
      if (pendingTargetRef.current === top) pendingTargetRef.current = null;
    }, 400);
  }, []);

  const scrollToTop = useCallback(() => {
    scrollToPosition(0);
  }, [scrollToPosition]);

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    // Clamped rather than raw scrollHeight: the browser clamps the scroll
    // itself, but the pending target is compared against real positions.
    scrollToPosition(Math.max(0, el.scrollHeight - el.clientHeight));
  }, [scrollToPosition]);

  /**
   * Row tops relative to the scroll container's content, in document order.
   *
   * Measured from the DOM instead of tracked alongside the message array:
   * hard filters and compact-mode grouping both change which nodes become
   * rows, and every row is variable-height, so an index-keyed model would
   * need the same measurement anyway.
   */
  const rowOffsets = useCallback((selector: string): number[] => {
    const scrollEl = parentRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return [];
    const containerTop = scrollEl.getBoundingClientRect().top;
    return Array.from(contentEl.querySelectorAll<HTMLElement>(selector)).map(
      (el) => el.getBoundingClientRect().top - containerTop + scrollEl.scrollTop,
    );
  }, []);

  /**
   * Both button pairs share this: the only difference between stepping
   * messages and stepping prompts is which rows supply the offsets.
   */
  const step = useCallback(
    (direction: StepDirection, selector: string) => {
      const el = parentRef.current;
      if (!el) return;
      const target = stepTarget({
        offsets: rowOffsets(selector),
        scrollTop: pendingTargetRef.current ?? el.scrollTop,
        direction,
      });
      if (target !== null) scrollToPosition(target);
    },
    [rowOffsets, scrollToPosition],
  );

  const stepPrev = useCallback(() => { step('prev', '[data-transcript-step]'); }, [step]);
  const stepNext = useCallback(() => { step('next', '[data-transcript-step]'); }, [step]);
  const promptPrev = useCallback(() => { step('prev', '[data-transcript-prompt]'); }, [step]);
  const promptNext = useCallback(() => { step('next', '[data-transcript-prompt]'); }, [step]);

  const hasPrompt = useMemo(
    () => displayableMessages.some(isMainPrompt),
    [displayableMessages],
  );

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Two-threshold hysteresis to prevent false "user scrolled up" detection.
    // Wider-than-you'd-expect thresholds so content-height jitter (code blocks
    // finishing layout, images loading) doesn't disengage stickiness, and the
    // user has real room to scroll back without the view yanking to the bottom.
    // The re-engage / disengage distances are user-tunable in
    // Settings → General (see AutoScrollContext / autoScrollThresholds).
    isNearBottomRef.current = nextNearBottom(
      distanceFromBottom,
      isNearBottomRef.current,
      { reengagePx, disengagePx },
    );
  }, [isNearBottomRef, reengagePx, disengagePx]);

  return (
    <div className="flex-1 min-h-0 px-10 py-2 bg-muted/30 relative">
    {findOpen && (
      <FindBar
        query={findQuery}
        onQueryChange={setFindQuery}
        count={findResults.count}
        activeIndex={findResults.activeIndex}
        onNext={findResults.next}
        onPrev={findResults.prev}
        onClose={() => { setFindOpen(false); setFindQuery(''); }}
      />
    )}
    {/* Sits on the left, beside the gutter it controls — the scroll buttons on
        the right are unrelated chrome. */}
    <div className="absolute left-1 bottom-6 z-10">
      <ContextTimelineToggle
        active={contextTimelineEnabled}
        onToggle={() => void setContextTimelineEnabled(!contextTimelineEnabled)}
      />
    </div>
    {/* Three icon families, because six stacked buttons are otherwise
        indistinguishable at 14px: double chevrons jump to an end, single
        chevrons step one message, arrows step one prompt. */}
    <div className="absolute right-1 bottom-6 z-10 flex flex-col gap-1">
      <TooltipSimple content="Scroll to top" side="left">
        <Button
          variant="ghost"
          size="icon"
          onClick={scrollToTop}
          aria-label="Scroll to top"
          className={NAV_BUTTON}
        >
          <ChevronsUp className="h-3.5 w-3.5" />
        </Button>
      </TooltipSimple>
      <TooltipSimple content="Previous message" side="left">
        <Button
          variant="ghost"
          size="icon"
          onClick={stepPrev}
          aria-label="Previous message"
          className={NAV_BUTTON}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
      </TooltipSimple>
      <TooltipSimple content="Next message" side="left">
        <Button
          variant="ghost"
          size="icon"
          onClick={stepNext}
          aria-label="Next message"
          className={NAV_BUTTON}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </TooltipSimple>
      {/* Separates the two step pairs. Without it the column reads as five
          interchangeable arrows and you have to hover to find the one you
          want. */}
      <div className="mx-auto my-0.5 h-px w-4 bg-border/60" aria-hidden="true" />
      {/* Wrapped in spans: a disabled Button swallows the pointer events the
          tooltip trigger needs, so the tooltip would vanish exactly when the
          reason for the disabled state is worth explaining. */}
      <TooltipSimple content="Previous prompt" side="left">
        <span>
          <Button
            variant="ghost"
            size="icon"
            onClick={promptPrev}
            aria-label="Previous prompt"
            disabled={!hasPrompt}
            className={NAV_BUTTON}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
        </span>
      </TooltipSimple>
      <TooltipSimple content="Next prompt" side="left">
        <span>
          <Button
            variant="ghost"
            size="icon"
            onClick={promptNext}
            aria-label="Next prompt"
            disabled={!hasPrompt}
            className={NAV_BUTTON}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
        </span>
      </TooltipSimple>
      <div className="mx-auto my-0.5 h-px w-4 bg-border/60" aria-hidden="true" />
      <TooltipSimple content="Scroll to bottom" side="left">
        <Button
          variant="ghost"
          size="icon"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          className={NAV_BUTTON}
        >
          <ChevronsDown className="h-3.5 w-3.5" />
        </Button>
      </TooltipSimple>
    </div>
    <div
      ref={parentRef}
      data-transcript-scroll
      className="h-full overflow-y-auto relative border border-border/50 rounded-lg bg-background"
      onScroll={handleScroll}
      style={{
        contain: 'paint',
      }}
    >
      {/* No `space-y-4` while the rail is on — the spacing lives inside each
          row instead, so the rail can run through it unbroken. */}
      <div
        ref={contentRef}
        className={cn("w-full px-4 pt-8 pb-4", !timeline && "space-y-4")}
      >
          {/* data-transcript-step / -prompt are the anchors the prev/next and
              last-prompt buttons measure. Marked on the row wrapper rather
              than counted in an array so they follow whatever the filters and
              the view mode actually rendered. */}
          {viewMode === 'verbose'
            ? displayableMessages.map((message, idx) => (
                <div
                  key={idx}
                  data-transcript-step={isStepStop(message) ? "" : undefined}
                  data-transcript-prompt={isMainPrompt(message) ? "" : undefined}
                >
                  {withTimeline(
                    message,
                    <StreamMessage
                      message={message}
                      streamMessages={messages}
                      onLinkDetected={onLinkDetected}
                      accountType={accountType}
                      onResend={onResend}
                    />,
                  )}
                </div>
              ))
            : (() => {
                const items = buildCompactItems(displayableMessages, renderConfig);
                return items.map((item) =>
                  item.kind === 'single' ? (
                    <div
                      key={item.key}
                      data-transcript-step={isStepStop(item.message) ? "" : undefined}
                      data-transcript-prompt={isMainPrompt(item.message) ? "" : undefined}
                    >
                      {withTimeline(
                        item.message,
                        <StreamMessage
                          message={item.message}
                          streamMessages={messages}
                          onLinkDetected={onLinkDetected}
                          accountType={accountType}
                          compact
                          onResend={onResend}
                        />,
                      )}
                    </div>
                  ) : (
                    // A collapsed group is one landable row: it holds only
                    // hidden events, so stepping past it entirely would skip
                    // the expander that reaches them.
                    <div key={item.key} data-transcript-step>
                      {/* A collapsed group reports its EXIT state — the context
                          size after everything inside it ran. */}
                      {withTimeline(
                        item.messages[item.messages.length - 1],
                        <HiddenEventsGroup
                          messages={item.messages}
                          streamMessages={messages}
                          accountType={accountType}
                          onLinkDetected={onLinkDetected}
                          onResend={onResend}
                        />,
                      )}
                    </div>
                  ),
                );
              })()}

          {/* Streaming bubble — renders null when no in-flight slot is set. */}
          <InflightAssistantBubble tabId={tabId} />

          {/* Loading indicator under the latest message — iMessage-style typing bubble.
              Rendered inside contentRef (and before messagesEndRef) so the ResizeObserver
              on contentRef catches its appearance/height changes, and scrollIntoView on
              messagesEndRef scrolls past it instead of leaving it below the viewport.
              Also kept visible during awaiting_background so the visual "in-flight"
              cue bridges the parent's turn-end result to the eventual completion. */}
          {outstandingWork && !hasInflightAssistant && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="flex justify-start mb-20"
            >
              <div className="max-w-[95%] space-y-2">
                <div className="flex items-center gap-3">
                  <div className="inline-flex items-center gap-1 rounded-2xl rounded-bl-sm bg-primary/10 border border-primary/20 px-4 py-3">
                    <span className="typing-dot" />
                    <span className="typing-dot" style={{ animationDelay: '0.15s' }} />
                    <span className="typing-dot" style={{ animationDelay: '0.3s' }} />
                  </div>
                  <div className="flex items-baseline gap-2 text-xs font-mono">
                    <span className="text-primary">✶</span>
                    <span className="text-muted-foreground">{currentActivity}...</span>
                    <span className="text-muted-foreground/60">
                      (↓ {totalTokens.toLocaleString()} tokens)
                    </span>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Error indicator */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive mb-20 w-full max-w-6xl mx-auto"
            >
              {error}
            </motion.div>
          )}

          <div ref={messagesEndRef} />
      </div>
    </div>
    </div>
  );
}
