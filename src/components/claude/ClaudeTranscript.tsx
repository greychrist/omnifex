import React, { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, MessageSquare, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipSimple } from "@/components/ui/tooltip-modern";
import { SessionGutter, GUTTER_BUTTON, GUTTER_GROUP_BUTTON, GutterButtonGroup, InspectorGutterButton, type InspectorGutterButtonProps } from "@/components/SessionGutter";
import { TranscriptRowBoundary } from "@/components/claude/TranscriptRowBoundary";
import { TranscriptSkeleton } from "@/components/claude/TranscriptSkeleton";
import { LiveActivity } from "@/components/transcript-modern/ChainOfThought";
import { phaseLabel } from "@/lib/phaseLabel";

const COMPACTING_LABEL = phaseLabel('compacting');
import { keepUnchangedItems, type ModernItem } from "@/lib/modernGrouping";
import { keepUnchangedFooters, modernTurnFooters, type TurnFooter } from "@/lib/modernTurnFooter";
import {
  ModernLiveAnswer,
  ModernTranscriptItem,
  anchorNodeOf,
  firstNodeOf,
  type ModernRowContext,
} from "@/components/transcript-modern/ModernTranscriptItem";
import { FindBar } from "@/components/FindBar";
import { useFindInChat } from "@/hooks/useFindInChat";
import { useRenderProfile } from "@/hooks/useRenderProfile";
import { renderProfiler } from "@/lib/renderProfiler";
import { MessageRenderingOverrideProvider, useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { displayableRecords, groupRecords } from "@/lib/transcriptItems";
import { useAutoScroll } from "@/contexts/AutoScrollContext";
import { useSessionGauges } from "@/contexts/SessionGaugesContext";
import { buildContextTimeline } from "@/lib/contextTimeline";
import { ContextTimelineTick } from "@/components/ContextTimelineTick";
import { ContextTimelineToggle } from "@/components/ContextTimelineToggle";
import { afterContentResize, nextFollowing, USER_SCROLL_INTENT_MS } from "@/lib/autoScrollFollow";
import { stepTarget, isStepStop, isMainPrompt, STEP_MARGIN_PX, type StepDirection } from "@/lib/transcriptStepper";
import { cn } from "@/lib/utils";
import { logAndForget } from "@/lib/fireAndLog";
import { earlierStart, windowStart } from "@/lib/transcriptWindow";
import type { JsonlNode } from "@/types/jsonl";
import type { ViewMode } from "@/components/SessionViewToggle";


const StepIcon: React.FC<{
  subject: React.ComponentType<{ className?: string }>;
  direction: React.ComponentType<{ className?: string }>;
}> = ({ subject: Subject, direction: Direction }) => (
  <span className="inline-flex items-center gap-px" aria-hidden="true">
    <Subject className="h-3 w-3" />
    <Direction className="h-3 w-3" />
  </span>
);

export interface ClaudeTranscriptProps extends InspectorGutterButtonProps {
  messages: JsonlNode[];
  viewMode: ViewMode;
  accountType: string | undefined;
  configDir?: string | null;
  onResend: (text: string, images: string[] | undefined) => void;
  waitingForPermission: boolean;
  outstandingWork: boolean;
  hasInflightAssistant: boolean;
  currentActivity: string;
  contextLimit: number;
  error: string | null;
  tabId: string;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  isNearBottomRef: React.RefObject<boolean>;
  jumpTo?: { uuid: string; nonce: number } | null;
}

const LOAD_EARLIER_PX = 800;

const JUMP_HIGHLIGHT_MS = 1600;

function messageUuidOf(message: JsonlNode): string | undefined {
  const uuid = (message as { raw?: { uuid?: unknown } }).raw?.uuid;
  return typeof uuid === "string" ? uuid : undefined;
}

const ROW_CLASS =
  "rounded-md transition-shadow duration-500 data-[jump-target]:ring-2 data-[jump-target]:ring-primary/60";

function ClaudeTranscriptImpl({
  messages,
  viewMode: liveViewMode,
  accountType,
  configDir,
  onResend,
  waitingForPermission,
  outstandingWork,
  hasInflightAssistant,
  currentActivity,
  contextLimit,
  error,
  tabId,
  messagesEndRef,
  isNearBottomRef,
  onOpenInspector,
  inspectorOpen,
  jumpTo = null,
}: ClaudeTranscriptProps): React.ReactElement {
  useRenderProfile('ClaudeTranscript');
  // History loads and format switches render in a transition; streamed
  // messages are not deferred.
  const [viewMode, setViewMode] = useState(liveViewMode);
  useEffect(() => {
    if (viewMode !== liveViewMode) startTransition(() => { setViewMode(liveViewMode); });
  }, [viewMode, liveViewMode]);
  const [historyShown, setHistoryShown] = useState(false);
  useEffect(() => {
    if (!historyShown && messages.length > 0) startTransition(() => { setHistoryShown(true); });
  }, [historyShown, messages.length]);
  const rendering = (messages.length > 0 && !historyShown) || viewMode !== liveViewMode;
  const { config: savedRenderConfig } = useMessageRenderingConfig();
  const { followPx } = useAutoScroll();
  const { contextTimelineEnabled, setContextTimelineEnabled, contextJump, contextPressure } =
    useSessionGauges();

  // Built over the FULL message array, keyed by node identity, so hard filters
  // can hide rows without shifting the series.
  const timeline = useMemo(
    () =>
      contextTimelineEnabled
        ? buildContextTimeline(messages, {
            limit: contextLimit,
            jumpThresholdTokens: contextJump.thresholdTokens,
            // Thresholds only: turning the banner off must not flatten the rail.
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

  // Repeats fold over the unfiltered list, so a hidden message still ends a run.
  const renderConfig = savedRenderConfig;
  const displayableMessages = useMemo(
    () => displayableRecords(messages, renderConfig, viewMode),
    [messages, renderConfig, viewMode],
  );

  // Valid for both view modes: compact only folds displayableMessages, and a
  // collapsed group reports its last one.
  const lastRailNode = useMemo(() => {
    if (!timeline) return undefined;
    for (let i = displayableMessages.length - 1; i >= 0; i--) {
      const node = displayableMessages[i];
      if (timeline.get(node)) return node;
    }
    return undefined;
  }, [timeline, displayableMessages]);

  // Row spacing lives inside the row (pb-4), not `space-y-4` on the container,
  // so consecutive rails meet instead of rendering as a dashed ladder.
  const withTimeline = (node: JsonlNode | undefined, body: React.ReactNode) => {
    if (!timeline) return body;
    return (
      <div className="flex">
        <ContextTimelineTick
          point={node ? timeline.get(node) : undefined}
          viewMode={viewMode}
          isLast={node !== undefined && node === lastRailNode}
        />
        <div className="flex-1 min-w-0 pb-4 pl-4">{body}</div>
      </div>
    );
  };

  // Unchanged items keep their previous object so an append re-renders only
  // the items it touched (keepUnchangedItems).
  const prevModernItemsRef = useRef<ModernItem[]>([]);
  const modernItems = useMemo(() => {
    const next = keepUnchangedItems(prevModernItemsRef.current, groupRecords(displayableMessages, renderConfig, messages, viewMode));
    prevModernItemsRef.current = next;
    return next;
  }, [viewMode, displayableMessages, renderConfig, messages]);
  // Unchanged footers keep their object for the same reason.
  const prevFootersRef = useRef<Map<string, TurnFooter>>(new Map());
  const turnFooters = useMemo(() => {
    const next = keepUnchangedFooters(prevFootersRef.current, modernTurnFooters(modernItems, messages, outstandingWork));
    prevFootersRef.current = next;
    return next;
  }, [modernItems, messages, outstandingWork]);
  const rowCount = modernItems.length;
  const lastModernItem = modernItems.length > 0 ? modernItems[modernItems.length - 1] : undefined;
  const liveRunShown = outstandingWork && lastModernItem?.kind === 'work';
  const compacting = currentActivity === COMPACTING_LABEL;
  const modernRowContext = useMemo<ModernRowContext>(
    () => ({ tabId, configDir, accountType, onResend }),
    [tabId, configDir, accountType, onResend],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');

  // A pin is a row index in one format; a pin made in another reads as no pin.
  const [pin, setPin] = useState<{ mode: ViewMode; start: number } | null>(null);
  const pinned = pin?.mode === viewMode ? pin.start : null;
  const jumpUuid = jumpTo?.uuid;
  const jumpNonce = jumpTo?.nonce;
  const jumpRow = useMemo(() => {
    if (!jumpUuid) return -1;
    return modernItems.findIndex((item) => messageUuidOf(firstNodeOf(item)) === jumpUuid);
  }, [jumpUuid, modernItems]);
  // Find walks the DOM, so everything mounts while the bar is open.
  const start = findOpen
    ? 0
    : Math.min(windowStart(rowCount, pinned), jumpRow >= 0 ? jumpRow : rowCount);
  const startRef = useRef(start);
  startRef.current = start;
  const pinRef = useRef(pinned);
  pinRef.current = pinned;
  renderProfiler.recordRenders('TranscriptRow(displayable)', rowCount - start);

  // Instant scroll while streaming: smooth scroll lags CLI bursts and sticks.
  useEffect(() => {
    if (displayableMessages.length > 0 && (isNearBottomRef.current || waitingForPermission)) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      });
    }
  }, [displayableMessages.length, waitingForPermission, isNearBottomRef, messagesEndRef]);

  // Height changes after the length effect fired (code blocks, images) need
  // their own follow, or the chat stops short of the bottom.
  const contentRef = useRef<HTMLDivElement>(null);

  // `data-following` is written imperatively: a re-render per scroll event
  // would cost every mounted tab.
  const followMarkerRef = useRef<HTMLDivElement>(null);
  const setFollowing = useCallback((following: boolean) => {
    isNearBottomRef.current = following;
    if (followMarkerRef.current) {
      followMarkerRef.current.dataset.following = String(following);
    }
  }, [isNearBottomRef]);
  const lastToggleAtRef = useRef(Number.NEGATIVE_INFINITY);

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
    transcriptVersion: messages.length,
  });

  useEffect(() => {
    const contentEl = contentRef.current;
    const scrollEl = parentRef.current;
    if (!contentEl || !scrollEl || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const { scroll, following } = afterContentResize({
        following: isNearBottomRef.current,
        distanceFromBottom: scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight,
        followPx,
        mustSee: waitingForPermission,
        userToggled: performance.now() - lastToggleAtRef.current <= USER_SCROLL_INTENT_MS,
      });
      setFollowing(following);
      if (scroll) {
        // Not scrollIntoView: it fights the smooth scroll the length effect started.
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });
    observer.observe(contentEl);
    return () => { observer.disconnect(); };
  }, [waitingForPermission, isNearBottomRef, followPx, setFollowing]);

  // Smooth scroll is async; holds the last target so rapid presses advance.
  const pendingTargetRef = useRef<number | null>(null);

  const scrollToPosition = useCallback((top: number) => {
    const el = parentRef.current;
    if (!el) return;
    pendingTargetRef.current = top;
    el.scrollTo({ top, behavior: 'smooth' });
    // Timer, not arrival: a cancelled scroll fires no arrival event.
    window.setTimeout(() => {
      if (pendingTargetRef.current === top) pendingTargetRef.current = null;
    }, 400);
  }, []);

  const pendingPrependRef = useRef<{ toTop: boolean; fromBottom: number } | null>(null);
  const growWindow = useCallback((nextStart: number, toTop: boolean) => {
    const el = parentRef.current;
    pendingPrependRef.current = { toTop, fromBottom: el ? el.scrollHeight - el.scrollTop : 0 };
    setPin({ mode: viewMode, start: nextStart });
  }, [viewMode]);
  useLayoutEffect(() => {
    const pending = pendingPrependRef.current;
    const el = parentRef.current;
    if (!pending || !el) return;
    pendingPrependRef.current = null;
    // Set, not animated: WebKit scroll anchoring cancels a smooth scroll as
    // rows mount above.
    el.scrollTop = pending.toTop ? 0 : el.scrollHeight - pending.fromBottom;
  }, [start]);
  const showEarlier = useCallback(() => {
    growWindow(earlierStart(startRef.current), false);
  }, [growWindow]);

  const scrollToTop = useCallback(() => {
    // Stop following first, or mounting rows pins the view to the new bottom.
    setFollowing(false);
    if (startRef.current > 0) growWindow(0, true);
    else scrollToPosition(0);
  }, [growWindow, scrollToPosition, setFollowing]);

  const hasEarlier = start > 0;

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    // Clamped: the pending target is compared against real positions.
    scrollToPosition(Math.max(0, el.scrollHeight - el.clientHeight));
  }, [scrollToPosition]);

  const rowOffsets = useCallback((selector: string): number[] => {
    const scrollEl = parentRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return [];
    const containerTop = scrollEl.getBoundingClientRect().top;
    return Array.from(contentEl.querySelectorAll<HTMLElement>(selector)).map(
      (el) => el.getBoundingClientRect().top - containerTop + scrollEl.scrollTop,
    );
  }, []);

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

  // Highlight is a DOM attribute, not state: state would re-render every row.
  useEffect(() => {
    if (!jumpUuid) return;
    const scrollEl = parentRef.current;
    const contentEl = contentRef.current;
    const row = contentEl?.querySelector<HTMLElement>(`[data-message-uuid="${CSS.escape(jumpUuid)}"]`);
    if (!scrollEl || !row) return;
    // Stop following the tail, or the next stream tick snaps back down.
    isNearBottomRef.current = false;
    const top = row.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
    scrollToPosition(Math.max(0, top - STEP_MARGIN_PX));
    row.setAttribute("data-jump-target", "");
    const timer = window.setTimeout(() => { row.removeAttribute("data-jump-target"); }, JUMP_HIGHLIGHT_MS);
    return () => {
      window.clearTimeout(timer);
      row.removeAttribute("data-jump-target");
    };
    // `start`: an out-of-window target is found once the window reaches it.
  }, [jumpUuid, jumpNonce, isNearBottomRef, scrollToPosition, start]);

  const stepPrev = useCallback(() => { step('prev', '[data-transcript-step]'); }, [step]);
  const stepNext = useCallback(() => { step('next', '[data-transcript-step]'); }, [step]);
  const promptPrev = useCallback(() => { step('prev', '[data-transcript-prompt]'); }, [step]);
  const promptNext = useCallback(() => { step('next', '[data-transcript-prompt]'); }, [step]);

  const hasPrompt = useMemo(
    () => displayableMessages.some(isMainPrompt),
    [displayableMessages],
  );


  // Only a scroll near user input may stop following (autoScrollFollow).
  const lastUserInputAtRef = useRef(Number.NEGATIVE_INFINITY);
  const pointerHeldRef = useRef(false);
  const markUserInput = useCallback((e: React.SyntheticEvent) => {
    lastUserInputAtRef.current = performance.now();
    // The expander's height change is the user's and must not scroll.
    if (e.target instanceof Element && e.target.closest('[aria-expanded]')) {
      lastToggleAtRef.current = lastUserInputAtRef.current;
    }
  }, [lastToggleAtRef]);
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    markUserInput(e);
    pointerHeldRef.current = true;
    const release = () => {
      pointerHeldRef.current = false;
      lastUserInputAtRef.current = performance.now();
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }, [markUserInput]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const following = nextFollowing({
      following: isNearBottomRef.current,
      distanceFromBottom,
      followPx,
      userScrolling:
        pointerHeldRef.current ||
        performance.now() - lastUserInputAtRef.current <= USER_SCROLL_INTENT_MS,
    });
    setFollowing(following);
    // Reading back: hold the window's top so streamed records do not unmount
    // the rows on screen.
    if (!following && pinRef.current === null) setPin({ mode: viewMode, start: startRef.current });
    else if (following && pinRef.current !== null) setPin(null);
    // Never while following: a short view is near its top and bottom at once.
    if (!following && startRef.current > 0 && el.scrollTop < LOAD_EARLIER_PX) showEarlier();
  }, [isNearBottomRef, followPx, setFollowing, viewMode, showEarlier]);

  const liveRows = <ModernLiveAnswer tabId={tabId} />;

  return (
    <MessageRenderingOverrideProvider config={renderConfig}>
    <div
      className={cn(
        "flex-1 min-h-0 py-2 bg-muted/30 relative",
        timeline ? "pr-10" : "px-10",
      )}
      onWheel={markUserInput}
      onTouchStart={markUserInput}
      onTouchMove={markUserInput}
      onKeyDown={markUserInput}
      onPointerDown={handlePointerDown}
    >
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
    <div data-timeline-toggle-slot className="absolute left-1 top-2 z-10">
      <ContextTimelineToggle
        active={contextTimelineEnabled}
        onToggle={() => { logAndForget('claude-transcript:context-timeline-toggle', setContextTimelineEnabled(!contextTimelineEnabled)); }}
      />
    </div>
    <SessionGutter
      top={
        <InspectorGutterButton
          onOpenInspector={onOpenInspector}
          inspectorOpen={inspectorOpen}
        />
      }
    >
      <TooltipSimple content="Scroll to top" side="left">
        <Button
          variant="ghost"
          size="icon"
          onClick={scrollToTop}
          aria-label="Scroll to top"
          className={GUTTER_BUTTON}
        >
          <ChevronsUp className="h-3.5 w-3.5" />
        </Button>
      </TooltipSimple>
      <GutterButtonGroup label="Step by message">
        <TooltipSimple content="Previous message" side="left">
          <Button
            variant="ghost"
            size="icon"
            onClick={stepPrev}
            aria-label="Previous message"
            className={GUTTER_GROUP_BUTTON}
          >
            <StepIcon subject={MessageSquare} direction={ChevronUp} />
          </Button>
        </TooltipSimple>
        <TooltipSimple content="Next message" side="left">
          <Button
            variant="ghost"
            size="icon"
            onClick={stepNext}
            aria-label="Next message"
            className={GUTTER_GROUP_BUTTON}
          >
            <StepIcon subject={MessageSquare} direction={ChevronDown} />
          </Button>
        </TooltipSimple>
      </GutterButtonGroup>
      <GutterButtonGroup label="Step by prompt">
        {/* Spans: a disabled Button swallows the pointer events the tooltip needs. */}
        <TooltipSimple content="Previous prompt" side="left">
          <span>
            <Button
              variant="ghost"
              size="icon"
              onClick={promptPrev}
              aria-label="Previous prompt"
              disabled={!hasPrompt}
              className={GUTTER_GROUP_BUTTON}
            >
              <StepIcon subject={User} direction={ChevronUp} />
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
              className={GUTTER_GROUP_BUTTON}
            >
              <StepIcon subject={User} direction={ChevronDown} />
            </Button>
          </span>
        </TooltipSimple>
      </GutterButtonGroup>
      <TooltipSimple content="Scroll to bottom" side="left">
        <Button
          variant="ghost"
          size="icon"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          className={GUTTER_BUTTON}
        >
          <ChevronsDown className="h-3.5 w-3.5" />
        </Button>
      </TooltipSimple>
    </SessionGutter>
    <div className="relative h-full">
    <div
      aria-hidden="true"
      data-transcript-frame
      className={cn(
        "pointer-events-none absolute inset-y-0 right-0 rounded-lg border border-border/50 bg-background",
        timeline ? "left-14" : "left-0",
      )}
    />
    <div
      ref={parentRef}
      data-transcript-scroll
      className={cn(
        "absolute inset-y-px right-px overflow-y-auto",
        timeline ? "left-0" : "left-px",
      )}
      onScroll={handleScroll}
      style={{
        contain: 'paint',
      }}
    >
      {/* No `space-y-4` while the rail is on, so the rail runs unbroken. */}
      <div
        ref={contentRef}
        className={cn(
          "relative w-full pt-8 pb-4",
          timeline ? "pr-4" : "px-4",
          "modern-format",
          !timeline && "space-y-4",
        )}
      >
          {hasEarlier && !rendering && withTimeline(
            undefined,
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={showEarlier}
                className="h-7 text-xs text-muted-foreground"
              >
                Show earlier · {start} more
              </Button>
            </div>,
          )}
          {rendering
            ? withTimeline(undefined, <TranscriptSkeleton />)
            : modernItems.slice(start).map((item, j) => {
                const i = start + j;
                const anchor = anchorNodeOf(item);
                const first = firstNodeOf(item);
                return (
                  <div
                    key={item.key}
                    className={ROW_CLASS}
                    data-message-uuid={messageUuidOf(first)}
                    data-transcript-step={isStepStop(first) ? "" : undefined}
                    data-transcript-prompt={item.kind === 'prompt' || isMainPrompt(first) ? "" : undefined}
                  >
                    {withTimeline(
                      anchor,
                      <TranscriptRowBoundary>
                        <ModernTranscriptItem
                          item={item}
                          live={outstandingWork && i === modernItems.length - 1}
                          ctx={modernRowContext}
                          footer={turnFooters.get(item.key)}
                        />
                      </TranscriptRowBoundary>,
                    )}
                  </div>
                );
              })}

          {/* Unwrapped when the rail is off: an empty wrapper would take a space-y gap. */}
          {timeline
            ? <div data-live-inset className="pl-18">{liveRows}</div>
            : liveRows}

          {!rendering && outstandingWork && !hasInflightAssistant && !waitingForPermission && (!liveRunShown || compacting) && withTimeline(
            undefined,
            <LiveActivity tabId={tabId} phase={compacting ? currentActivity : null} />,
          )}

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

          {/* Last child, so it never shifts the row indexes anything counts. */}
          <div
            ref={followMarkerRef}
            aria-hidden="true"
            data-autoscroll-marker
            data-following="true"
            className="pointer-events-none absolute right-0.5 h-1.5 w-1.5 translate-y-1/2 rounded-full text-muted-foreground/40 bg-current data-[following=false]:bg-transparent"
            // styles.css overrides border-color utilities and strips rings.
            style={{ bottom: followPx, boxShadow: 'inset 0 0 0 1px currentColor' }}
          />
      </div>
    </div>
    </div>
    </div>
    </MessageRenderingOverrideProvider>
  );
}

/**
 * Every tab stays mounted, so every prop must stay referentially stable or
 * memo does nothing (ClaudeTranscript.memo.test.tsx).
 */
export const ClaudeTranscript = React.memo(ClaudeTranscriptImpl);
