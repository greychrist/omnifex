import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, MessageSquare, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipSimple } from "@/components/ui/tooltip-modern";
import { SessionGutter, GUTTER_BUTTON, InspectorGutterButton, type InspectorGutterButtonProps } from "@/components/SessionGutter";
import { StreamMessage } from "@/components/StreamMessage";
import { TranscriptRowBoundary } from "@/components/claude/TranscriptRowBoundary";
import { HiddenEventsGroup } from "@/components/HiddenEventsGroup";
import { TranscriptSkeleton } from "@/components/claude/TranscriptSkeleton";
import { LiveActivity } from "@/components/transcript-modern/ChainOfThought";
import { phaseLabel } from "@/lib/phaseLabel";

const COMPACTING_LABEL = phaseLabel('compacting');
import { buildModernItems, keepUnchangedItems, type ModernItem } from "@/lib/modernGrouping";
import {
  ModernLiveAnswer,
  ModernTranscriptItem,
  anchorNodeOf,
  firstNodeOf,
  type ModernRowContext,
} from "@/components/transcript-modern/ModernTranscriptItem";
import { InflightAssistantBubble } from "@/components/InflightAssistantBubble";
import { InflightThinking } from "@/components/InflightThinking";
import { FindBar } from "@/components/FindBar";
import { useFindInChat } from "@/hooks/useFindInChat";
import { useRenderProfile } from "@/hooks/useRenderProfile";
import { renderProfiler } from "@/lib/renderProfiler";
import { buildCompactItems, withoutNeverShown } from "@/lib/compactGrouping";
import { collapseRepeats } from "@/lib/collapseRepeats";
import { filterDisplayableMessages } from "@/lib/messageFilters";
import { createRowLookupCache, rowLookups } from "@/lib/rowLookups";
import { MessageRenderingOverrideProvider, useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { revealNeverShown } from "@/lib/messageRenderingConfig";
import { useAutoScroll } from "@/contexts/AutoScrollContext";
import { useSessionGauges } from "@/contexts/SessionGaugesContext";
import { buildContextTimeline } from "@/lib/contextTimeline";
import { ContextTimelineTick } from "@/components/ContextTimelineTick";
import { ContextTimelineToggle } from "@/components/ContextTimelineToggle";
import { afterContentResize, nextFollowing, USER_SCROLL_INTENT_MS } from "@/lib/autoScrollFollow";
import { stepTarget, isStepStop, isMainPrompt, STEP_MARGIN_PX, type StepDirection } from "@/lib/transcriptStepper";
import { cn } from "@/lib/utils";
import { logAndForget } from "@/lib/fireAndLog";
import { rowKeyOf } from "@/lib/rowKey";
import type { JsonlNode } from "@/types/jsonl";
import type { ViewMode } from "@/components/SessionViewToggle";


/**
 * A stepper's icon: what it steps over, then which way. Both glyphs drop to
 * 12px so the pair still fits the 32px button, and both are decorative — the
 * Button already carries the accessible name.
 */
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
  /** All stream messages for this tab. Rows get only what they read of it — see `rowLookups`. */
  messages: JsonlNode[];
  /** Verbose vs. compact rendering mode. */
  viewMode: ViewMode;
  /** Resolved account type, used by StreamMessage for account-specific UI. */
  accountType: string | undefined;
  /** Stable resend callback (memoized in the shell). */
  onResend: (text: string, images: string[] | undefined) => void;
  /** Called when a URL is detected inside a rendered message. */
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
  // React 19: `useRef<T>(null)` is typed `RefObject<T | null>`, so a prop
  // that accepts a caller's ref has to admit null too.
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Mutable flag tracking whether the user is currently near the bottom of
   * the transcript. The shell flips this true when sending a new prompt so
   * the view re-engages stickiness even if the user had scrolled up.
   */
  isNearBottomRef: React.MutableRefObject<boolean>;
  /**
   * Scroll to the row holding this message uuid. `nonce` makes a second jump
   * to the same message a new request rather than an unchanged prop.
   */
  jumpTo?: { uuid: string; nonce: number } | null;
}

/** How long a jumped-to row stays highlighted. */
const JUMP_HIGHLIGHT_MS = 1600;

/** The transcript uuid of a row's message, which a jump looks rows up by. */
function messageUuidOf(message: JsonlNode): string | undefined {
  const uuid = (message as { raw?: { uuid?: unknown } }).raw?.uuid;
  return typeof uuid === "string" ? uuid : undefined;
}

/** Row wrapper styling: the ring a jump lights up and then lets fade. */
const ROW_CLASS =
  "rounded-md transition-shadow duration-500 data-[jump-target]:ring-2 data-[jump-target]:ring-primary/60";

/**
 * Claude transcript — the body of the chat. Renders all messages, the
 * streaming bubble, the typing-dots row, and an inline error card. Owns
 * the find-in-chat bar and the scroll machinery (stick-to-bottom logic,
 * the scroll/step navigation buttons, resize observer).
 *
 * Extracted from `ClaudeCodeSession` (now `AgentSession`) so the agent
 * shell can swap Claude vs. Codex transcripts without duplicating chrome.
 */
function ClaudeTranscriptImpl({
  messages,
  viewMode: liveViewMode,
  accountType,
  onResend,
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
  onOpenInspector,
  inspectorOpen,
  jumpTo = null,
}: ClaudeTranscriptProps): React.ReactElement {
  useRenderProfile('ClaudeTranscript');
  // A tab's first paint of its history, and a chat-format switch, can mean
  // thousands of rows. Both go through a transition: the skeleton commits at
  // once, and the rows render in the background, interruptibly, instead of
  // freezing the window with nothing on screen. Streamed messages are not
  // deferred — each still renders exactly once.
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
  // The "All" chat format renders through a copy of the config with every
  // "Never" kind demoted to verbose-only; rows get it from context below.
  const showAll = viewMode === 'all';
  const renderConfig = useMemo(
    () => (showAll ? revealNeverShown(savedRenderConfig) : savedRenderConfig),
    [showAll, savedRenderConfig],
  );
  const { followPx } = useAutoScroll();
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

  // Filter out messages that shouldn't be displayed (folds repeats per each
  // kind's collapse rule, honors the user's hard-filter toggles and the kinds
  // set to "Never" in Appearance settings). Repeats fold first, over the
  // unfiltered list, so a hidden message still ends a run.
  const displayableMessages = useMemo(
    () => withoutNeverShown(
      filterDisplayableMessages(collapseRepeats(messages, renderConfig)),
      renderConfig,
    ),
    [messages, renderConfig],
  );
  /**
   * The last row that will actually draw a rail — the tail of the transcript
   * can be rows the timeline has no reading for, and those render an empty
   * gutter spacer.
   *
   * Derived from `displayableMessages` for BOTH view modes, which works
   * because compact mode only ever folds those same messages: a `single` item
   * carries one of them, and a collapsed group reports its LAST one. So the
   * final message with a point is the final row with a rail either way.
   */
  const lastRailNode = useMemo(() => {
    if (!timeline) return undefined;
    for (let i = displayableMessages.length - 1; i >= 0; i--) {
      const node = displayableMessages[i];
      if (timeline.get(node)) return node;
    }
    return undefined;
  }, [timeline, displayableMessages]);

  // The transcript is not virtualised, so every render walks this whole list.
  // Recorded as a bulk count: in verbose mode it is exactly the rows rendered,
  // in compact mode an upper bound (grouping folds some rows together).
  renderProfiler.recordRenders('TranscriptRow(displayable)', displayableMessages.length);

  // What each row needs from the rest of the transcript, as an object that
  // keeps its identity while the answers do — which is what lets a row's memo
  // hold when a record is appended. See `rowLookups` for the freeze this fixes.
  const [rowLookupCache] = useState(createRowLookupCache);
  const lookupsFor = useCallback(
    (node: JsonlNode) => rowLookups(node, messages, rowLookupCache),
    [messages, rowLookupCache],
  );

  // Modern format: the same displayable rows, grouped into a conversation.
  // Unchanged items keep their previous object, and the row context reads
  // lookups through a ref, so appending a record re-renders only the items it
  // touched — not every row (see keepUnchangedItems).
  const prevModernItemsRef = useRef<ModernItem[]>([]);
  const modernItems = useMemo(() => {
    const next = viewMode === 'modern'
      ? keepUnchangedItems(prevModernItemsRef.current, buildModernItems(displayableMessages, renderConfig, messages))
      : [];
    prevModernItemsRef.current = next;
    return next;
  }, [viewMode, displayableMessages, renderConfig, messages]);
  const lookupsForRef = useRef(lookupsFor);
  lookupsForRef.current = lookupsFor;
  const stableLookupsFor = useCallback((node: JsonlNode) => lookupsForRef.current(node), []);
  const lastModernItem = modernItems.length > 0 ? modernItems[modernItems.length - 1] : undefined;
  // The live run shows the turn's activity itself; otherwise it gets a line of
  // its own below the items.
  const liveRunShown = outstandingWork && lastModernItem?.kind === 'work';
  // Compaction is the one phase worth naming: it is long, and nothing else
  // moves while it runs. It shows even under a live run (auto-compact).
  const compacting = currentActivity === COMPACTING_LABEL;
  const modernRowContext = useMemo<ModernRowContext>(
    () => ({ lookupsFor: stableLookupsFor, tabId, accountType, onResend }),
    [stableLookupsFor, tabId, accountType, onResend],
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

  // The follow marker: a pale dot `followPx` above the end of the content.
  // Following is `distanceFromBottom <= followPx`, so the dot is on screen
  // exactly when the transcript should be following. Its `data-following`
  // is written here, imperatively, because the decision lives in a ref and a
  // re-render per scroll event would cost every mounted tab.
  const followMarkerRef = useRef<HTMLDivElement>(null);
  const setFollowing = useCallback((following: boolean) => {
    isNearBottomRef.current = following;
    if (followMarkerRef.current) {
      followMarkerRef.current.dataset.following = String(following);
    }
  }, [isNearBottomRef]);
  // When the user last pressed a row's expander (see markUserInput).
  const lastToggleAtRef = useRef(Number.NEGATIVE_INFINITY);

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
      const { scroll, following } = afterContentResize({
        following: isNearBottomRef.current,
        distanceFromBottom: scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight,
        followPx,
        mustSee: waitingForPermission,
        userToggled: performance.now() - lastToggleAtRef.current <= USER_SCROLL_INTENT_MS,
      });
      setFollowing(following);
      if (scroll) {
        // Direct scrollTop assignment — cheaper than scrollIntoView and doesn't
        // fight the smooth-scroll animation the length-change effect may have
        // just kicked off in the same frame.
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });
    observer.observe(contentEl);
    return () => { observer.disconnect(); };
  }, [waitingForPermission, isNearBottomRef, followPx, setFollowing]);

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

  // A jump from outside (the session popover's Recent events). The highlight
  // is a DOM attribute rather than state: setting state here would re-render
  // every row of an unvirtualised transcript to light up one of them.
  const jumpUuid = jumpTo?.uuid;
  const jumpNonce = jumpTo?.nonce;
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
  }, [jumpUuid, jumpNonce, isNearBottomRef, scrollToPosition]);

  const stepPrev = useCallback(() => { step('prev', '[data-transcript-step]'); }, [step]);
  const stepNext = useCallback(() => { step('next', '[data-transcript-step]'); }, [step]);
  const promptPrev = useCallback(() => { step('prev', '[data-transcript-prompt]'); }, [step]);
  const promptNext = useCallback(() => { step('next', '[data-transcript-prompt]'); }, [step]);

  const hasPrompt = useMemo(
    () => displayableMessages.some(isMainPrompt),
    [displayableMessages],
  );


  // When the user last touched the transcript, and whether a pointer is held
  // (a scrollbar drag is one pointerdown and then however long the drag
  // takes). Only a scroll near one of these may stop following — see
  // autoScrollFollow. Bound on the wrapper, so the find bar and the gutter's
  // step buttons count too; the prompt box sits outside it and does not.
  const lastUserInputAtRef = useRef(Number.NEGATIVE_INFINITY);
  const pointerHeldRef = useRef(false);
  const markUserInput = useCallback((e: React.SyntheticEvent) => {
    lastUserInputAtRef.current = performance.now();
    // A press on a row's expander: the height change it causes is the
    // user's, and must not scroll (see afterContentResize).
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
    // The distance is user-tunable in Settings → General (see
    // AutoScrollContext / autoScrollFollow).
    setFollowing(nextFollowing({
      following: isNearBottomRef.current,
      distanceFromBottom,
      followPx,
      userScrolling:
        pointerHeldRef.current ||
        performance.now() - lastUserInputAtRef.current <= USER_SCROLL_INTENT_MS,
    }));
  }, [isNearBottomRef, followPx, setFollowing]);

  const liveRows = (
    <>
      {/* The thought being typed (classic formats; Modern draws its own in
          the live run). Renders null when no thought is streaming. */}
      {viewMode !== 'modern' && !rendering && <InflightThinking tabId={tabId} />}
      {/* Streaming answer — renders null when no in-flight slot is set.
          Modern streams it in its own style, so the finished answer does not
          change look when its record lands. */}
      {viewMode === 'modern'
        ? <ModernLiveAnswer tabId={tabId} />
        : <InflightAssistantBubble tabId={tabId} />}
    </>
  );

  return (
    <MessageRenderingOverrideProvider config={renderConfig}>
    <div
      className={cn(
        "flex-1 min-h-0 py-2 bg-muted/30 relative",
        // With the rail on, the left margin is the rail's: the scroller
        // reaches into it (see data-transcript-frame below).
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
    {/* Top of the left gutter it controls, level with the frame's top edge
        (the container's py-2) — the scroll buttons on the right are
        unrelated chrome. */}
    <div data-timeline-toggle-slot className="absolute left-1 top-2 z-10">
      <ContextTimelineToggle
        active={contextTimelineEnabled}
        onToggle={() => { logAndForget('claude-transcript:context-timeline-toggle', setContextTimelineEnabled(!contextTimelineEnabled)); }}
      />
    </div>
    {/* Each stepper is a subject glyph plus a direction glyph, because six
        buttons stacked in a 32px column are otherwise four near-identical
        up/down arrows you have to hover to tell apart: a chat bubble steps
        one message, a person steps one user prompt. The two jump-to-end
        buttons stay bare double chevrons — they have no subject. */}
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
      <TooltipSimple content="Previous message" side="left">
        <Button
          variant="ghost"
          size="icon"
          onClick={stepPrev}
          aria-label="Previous message"
          className={GUTTER_BUTTON}
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
          className={GUTTER_BUTTON}
        >
          <StepIcon subject={MessageSquare} direction={ChevronDown} />
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
            className={GUTTER_BUTTON}
          >
            <StepIcon subject={User} direction={ArrowUp} />
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
            className={GUTTER_BUTTON}
          >
            <StepIcon subject={User} direction={ArrowDown} />
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
          className={GUTTER_BUTTON}
        >
          <ChevronsDown className="h-3.5 w-3.5" />
        </Button>
      </TooltipSimple>
    </SessionGutter>
    <div className="relative h-full">
    {/* The chat frame, drawn behind the scroller rather than being it. The
        scroller spans the left margin too, so the context rail scrolls with
        its rows while sitting outside the frame, in the gutter. Inset 1px so
        rows scrolling past never paint over the frame's own edge. */}
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
      {/* No `space-y-4` while the rail is on — the spacing lives inside each
          row instead, so the rail can run through it unbroken. */}
      <div
        ref={contentRef}
        className={cn(
          "relative w-full pt-8 pb-4",
          // With the rail on, the gutter cell starts each row at the left
          // edge and the row's body carries the inset.
          timeline ? "pr-4" : "px-4",
          viewMode === 'modern' && "modern-format",
          !timeline && "space-y-4",
        )}
      >
          {/* data-transcript-step / -prompt are the anchors the prev/next and
              last-prompt buttons measure. Marked on the row wrapper rather
              than counted in an array so they follow whatever the filters and
              the view mode actually rendered. */}
          {rendering
            // In a row like any other: with the rail on, the row's gutter is
            // what keeps it inside the chat frame.
            ? withTimeline(undefined, <TranscriptSkeleton />)
            : viewMode === 'modern'
            ? modernItems.map((item, i) => {
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
                        />
                      </TranscriptRowBoundary>,
                    )}
                  </div>
                );
              })
            : viewMode !== 'compact'
            ? displayableMessages.map((message) => (
                <div
                  key={rowKeyOf(message)}
                  className={ROW_CLASS}
                  data-message-uuid={messageUuidOf(message)}
                  data-transcript-step={isStepStop(message) ? "" : undefined}
                  data-transcript-prompt={isMainPrompt(message) ? "" : undefined}
                >
                  {withTimeline(
                    message,
                    <TranscriptRowBoundary>
                      <StreamMessage
                        message={message}
                        lookups={lookupsFor(message)}
                        tabId={tabId}
                        accountType={accountType}
                        onResend={onResend}
                      />
                    </TranscriptRowBoundary>,
                  )}
                </div>
              ))
            : (() => {
                const items = buildCompactItems(displayableMessages, renderConfig);
                return items.map((item) =>
                  item.kind === 'single' ? (
                    <div
                      key={item.key}
                      className={ROW_CLASS}
                      data-message-uuid={messageUuidOf(item.message)}
                      data-transcript-step={isStepStop(item.message) ? "" : undefined}
                      data-transcript-prompt={isMainPrompt(item.message) ? "" : undefined}
                    >
                      {withTimeline(
                        item.message,
                        <TranscriptRowBoundary>
                          <StreamMessage
                            message={item.message}
                            lookups={lookupsFor(item.message)}
                            tabId={tabId}
                            accountType={accountType}
                            compact
                            onResend={onResend}
                          />
                        </TranscriptRowBoundary>,
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
                          lookupsFor={lookupsFor}
                          tabId={tabId}
                          accountType={accountType}
                          onResend={onResend}
                        />,
                      )}
                    </div>
                  ),
                );
              })()}

          {/* The live rows render nothing most of the time, so they are not
              timeline rows (a row's spacing would leave a gap). With the rail
              on they take its inset — gutter plus the row's own — so they stay
              inside the chat frame. Unwrapped otherwise: an empty wrapper
              would take a space-y gap of its own. */}
          {timeline
            ? <div data-live-inset className="pl-18">{liveRows}</div>
            : liveRows}

          {/* Modern: the running turn's activity when no live run shows it. */}
          {viewMode === 'modern' && !rendering && outstandingWork && !hasInflightAssistant && !waitingForPermission && (!liveRunShown || compacting) && withTimeline(
            undefined,
            <LiveActivity tabId={tabId} phase={compacting ? currentActivity : null} />,
          )}

          {/* Loading indicator under the latest message — iMessage-style typing bubble.
              Rendered inside contentRef (and before messagesEndRef) so the ResizeObserver
              on contentRef catches its appearance/height changes, and scrollIntoView on
              messagesEndRef scrolls past it instead of leaving it below the viewport.
              Also kept visible during awaiting_background so the visual "in-flight"
              cue bridges the parent's turn-end result to the eventual completion. */}
          {outstandingWork && !hasInflightAssistant && viewMode !== 'modern' && withTimeline(
            // No node, so the gutter cell is the empty spacer and the rail
            // still ends on the last real message. The point is purely the
            // indent: unwrapped, the dots bubble started hard against the
            // transcript's left edge while every message card sat a gutter's
            // width to the right of it.
            undefined,
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
            </motion.div>,
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

          {/* Last child, so it never shifts the row indexes anything counts.
              Centred on the threshold line; hollow once following is off. */}
          <div
            ref={followMarkerRef}
            aria-hidden="true"
            data-autoscroll-marker
            data-following="true"
            className="pointer-events-none absolute right-0.5 h-1.5 w-1.5 translate-y-1/2 rounded-full text-muted-foreground/40 bg-current data-[following=false]:bg-transparent"
            // Outline via currentColor: styles.css overrides every
            // border-colour utility and strips the ring classes.
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
 * Memoised because the transcript is the most expensive thing in the app and
 * the cheapest thing to skip.
 *
 * Every tab stays mounted — TabContent hides inactive panels with a CSS class
 * rather than unmounting them — so a change to `activeTabId` re-renders every
 * panel in the app. Measured in packaged 0.4.133, one tab click cost ~1435
 * renders in ~110ms, 1419 of them transcript rows belonging to sessions the
 * user was not even looking at. `isActive` is not a prop here, so none of that
 * work could ever change a pixel of this subtree.
 *
 * The guard rail this needs: every prop must stay referentially stable across
 * a parent re-render, or memo silently does nothing. `onResendStable` is the
 * standing example — a bare arrow there re-rendered every transcript row in
 * every open tab. (`onLinkDetected` was the same trap, and was ref-captured
 * for it; the prop is gone now that the preview pane it fed was deleted.)
 * See ClaudeTranscript.memo.test.tsx, which fails if that regresses.
 */
export const ClaudeTranscript = React.memo(ClaudeTranscriptImpl);
