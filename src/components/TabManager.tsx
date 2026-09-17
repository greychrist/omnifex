import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { X, Plus, MessageSquare, Folder, Server, Settings, FileText, HardDrive, List, Brain, DollarSign } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { TabStatusGlyph } from '@/components/TabStatusGlyph';
// Re-exported: TabManager's own tests import it from here, and so does
// anything already reaching for it. The definition moved out so the
// session status bar can render the same glyph.
import { AgentCountGlyph } from '@/components/AgentCountGlyph';
export { AgentCountGlyph };
import { AccountBadge } from './AccountBadge';
import { AccountTabGlyph } from './AccountTabGlyph';
import { useTabState } from '@/hooks/useTabState';
import { Tab, useTabContext } from '@/contexts/TabContext';
import { useSecondTick } from '@/hooks/useSecondTick';
import { useRenderProfile } from '@/hooks/useRenderProfile';
import { useTabSessionTitle } from '@/stores/claudeSessionStore';
import { renderProfiler } from '@/lib/renderProfiler';
import { evaluateCacheExpiry } from '@/lib/cacheExpiry';
import { cn } from '@/lib/utils';
import { fireAndLog } from "@/lib/fireAndLog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onClose: (id: string) => void;
  onClick: (id: string) => void;
  isDragging?: boolean;
  setDraggedTabId?: (id: string | null) => void;
}

// Per-tab `icon` string overrides the type-based default. Today this is
// used by the projects tab to flip Folder → List once the user drills
// into a project's sessions view, and stays unset everywhere else so
// the type defaults below win. Add new entries here as needed; unknown
// ids fall through to the type default rather than throwing, so a stale
// persisted value can't break the tab strip.
const TAB_ICON_OVERRIDES: Record<string, typeof MessageSquare> = {
  list: List,
};

/**
 * Pure icon resolver — exported for testing. The `tab.icon` string takes
 * precedence over the `tab.type` default, but unknown override values
 * silently fall through to the type-based switch.
 */
export function getTabIcon(tab: Pick<Tab, 'type' | 'icon'>): typeof MessageSquare {
  if (tab.icon && TAB_ICON_OVERRIDES[tab.icon]) {
    return TAB_ICON_OVERRIDES[tab.icon];
  }
  switch (tab.type) {
    case 'chat':
      return MessageSquare;
    case 'projects':
      return Folder;
    case 'mcp':
      return Server;
    case 'lima':
      return HardDrive;
    case 'brain':
      return Brain;
    case 'cost-report':
      return DollarSign;
    case 'settings':
      return Settings;
    case 'claude-md':
    case 'claude-file':
      return FileText;
    default:
      return MessageSquare;
  }
}

export type TabStatusIndicator =
  | { kind: 'error' }
  | { kind: 'permission' }
  | { kind: 'question' }
  | { kind: 'spinner' }
  | { kind: 'agents'; count: number }
  | { kind: 'complete' }
  | { kind: 'cacheExpiring'; critical: boolean };

/**
 * Pure precedence resolver for a tab's status glyph — exported for testing,
 * like getTabIcon. `nowMs` is passed in so the cache countdown stays
 * deterministic under test.
 */
export function resolveTabStatusIndicator(
  tab: Tab,
  nowMs: number,
): TabStatusIndicator | null {
  if (tab.status === 'error') return { kind: 'error' };
  // Waiting on the human outranks the spinner: a pending permission keeps
  // the conversation "running" (open task), so the tab is both working AND
  // blocked on the user. Surface what the user can act on, not just "busy".
  if (tab.waitingFor === 'permission') return { kind: 'permission' };
  if (tab.waitingFor === 'question') return { kind: 'question' };
  // Spinner reflects promptStatus (working = agent is doing work: main
  // turn in flight, active task, or running subagent). Falls back to
  // the older `status === 'running'` for tabs that haven't published
  // promptStatus yet (non-chat tabs or pre-mount). Not configurable.
  // Running agents outrank the spinner. A backgrounded agent's launching
  // turn is already over (CLI >=2.1.232 backgrounds spawns by default), so
  // the tab is "working" with nothing visibly happening inside it — a bare
  // spinner reads the same as Claude mid-sentence and says nothing about
  // what the session is actually waiting on. The count does.
  if (tab.activeAgents && tab.activeAgents > 0) {
    return { kind: 'agents', count: tab.activeAgents };
  }
  if (tab.promptStatus === 'working' || (!tab.promptStatus && tab.status === 'running')) {
    return { kind: 'spinner' };
  }
  // Completed: a result landed on a background tab (cleared on read).
  if (tab.hasUnreadResult) return { kind: 'complete' };
  // Ambient, so it ranks last: the prompt cache on a background session is
  // about to expire. Cleared once expired — the cost is already sunk, and a
  // permanent glyph would just be noise.
  if (tab.cacheAnchorMs != null && tab.cacheTtlMs != null) {
    const { level } = evaluateCacheExpiry({
      anchorMs: tab.cacheAnchorMs,
      ttlMs: tab.cacheTtlMs,
      nowMs,
    });
    if (level === 'warn' || level === 'critical') {
      return { kind: 'cacheExpiring', critical: level === 'critical' };
    }
  }
  return null;
}

/**
 * Glyph kinds that mean the session still has work in it — either the agent is
 * mid-turn, or it is blocked waiting on the human and the turn is still open.
 */
const LIVE_WORK_KINDS: ReadonlySet<TabStatusIndicator['kind']> = new Set([
  'spinner',
  'agents',
  'permission',
  'question',
]);

/**
 * True when closing this tab would discard work in progress, so the close
 * should be confirmed first.
 *
 * Closing a tab is the ONLY path that tears down the main-process CLI session
 * (`TabContext.removeTab` → `api.stopSession`) — a misclick on the × ends a
 * running turn with no way back.
 *
 * Derived from `resolveTabStatusIndicator` rather than re-reading
 * `promptStatus` / `activeAgents` / `waitingFor` directly: the tab strip
 * already owns the question of what a tab is doing, and its precedence rules
 * are load-bearing here. `error` outranking everything is what keeps a dead
 * session from prompting (the lifecycle doc is explicit that an errored
 * session is not in flight), and `hasUnreadResult` ranking below the working
 * kinds is what keeps a finished turn from prompting.
 */
export function tabCloseNeedsConfirm(tab: Tab, nowMs: number): boolean {
  const indicator = resolveTabStatusIndicator(tab, nowMs);
  return indicator !== null && LIVE_WORK_KINDS.has(indicator.kind);
}


const TabItem: React.FC<TabItemProps> = ({ tab, isActive, onClose, onClick, isDragging = false, setDraggedTabId }) => {
  useRenderProfile('TabItem');
  const [isHovered, setIsHovered] = useState(false);
  const { config } = useMessageRenderingConfig();
  // `compact` drops the second text line; the tab keeps its glyph, status and
  // close button. The session name still feeds the hover title either way.
  const compact = config.tabs.density === 'compact';
  const accountName = tab.accountName;
  // The strip shows the PROJECT name — that is what you navigate by — so the
  // session's own name goes on hover, where it tells two tabs on the same
  // project apart without widening either. Undefined when the session has no
  // name yet: a tooltip repeating the label already printed on the tab is
  // noise, and untitled is the common case.
  const sessionName = useTabSessionTitle(tab.id);

  // Tick only while this tab has a live (unexpired) cache clock. Once the
  // countdown is done `active` goes false and the shared interval drops this
  // subscriber — an idle tab strip runs no timer at all.
  const cacheTracking = tab.cacheAnchorMs != null && tab.cacheTtlMs != null;
  const [cacheTickActive, setCacheTickActive] = useState(cacheTracking);
  const nowMs = useSecondTick(cacheTickActive);
  const indicator = resolveTabStatusIndicator(tab, nowMs);
  const cacheDone =
    cacheTracking && nowMs - (tab.cacheAnchorMs ?? 0) >= (tab.cacheTtlMs ?? 0);
  useEffect(() => {
    setCacheTickActive(cacheTracking && !cacheDone);
  }, [cacheTracking, cacheDone]);

  const getStatusIcon = () => {
    const ind = config.tabIndicators;
    const palette = config.palette;
    switch (indicator?.kind) {
      case 'error':
        return <TabStatusGlyph style={ind.error} indicators={ind} palette={palette} ariaLabel="Error" />;
      case 'permission':
        return <TabStatusGlyph style={ind.permission} indicators={ind} palette={palette} ariaLabel="Permission request" />;
      case 'question':
        return <TabStatusGlyph style={ind.question} indicators={ind} palette={palette} ariaLabel="Question waiting" />;
      case 'spinner':
        return <Spinner className="size-3.5" />;
      case 'agents':
        return <AgentCountGlyph count={indicator.count} />;
      case 'complete':
        return <TabStatusGlyph style={ind.complete} indicators={ind} palette={palette} ariaLabel="Completed" />;
      case 'cacheExpiring':
        return (
          <TabStatusGlyph
            style={ind.cacheExpiring}
            indicators={ind}
            palette={palette}
            ariaLabel={indicator.critical ? "Prompt cache about to expire" : "Prompt cache expiring soon"}
            // A slow countdown must not strobe for minutes.
            pulse={false}
            colorOverride={indicator.critical ? 'red' : undefined}
          />
        );
      default:
        return null;
    }
  };

  const Icon = getTabIcon(tab);
  const statusIcon = getStatusIcon();

  return (
    <Reorder.Item
      value={tab}
      id={tab.id}
      dragListener={true}
      // Don't transition `transform` here — framer-motion already animates
      // it during the drag. A CSS `transition-all` would fight that and
      // produce the jumpy reorder. Limit CSS transitions to colors / bg.
      whileDrag={{ scale: 1.02, zIndex: 30, cursor: 'grabbing' }}
      className={cn(
        "relative flex items-center gap-[7px] text-[15px] cursor-pointer select-none group",
        "transition-colors duration-100",
        // Height is fixed rather than content-driven so an unnamed session's
        // tab still lines up with its neighbours. Expanded reserves the second
        // line for the session name; compact is a single row.
        "rounded-md px-[10px]",
        compact ? "h-[30px]" : "h-[38px]",
        // Size to content (with a sensible floor) instead of capping width:
        // the tab grows to fit the full project name. shrink-0 keeps the tab
        // from being compressed when many are open — the strip is
        // overflow-x-auto, so long names scroll rather than truncate.
        "min-w-[120px] w-max shrink-0",
        isActive
          ? "text-foreground bg-background shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_75%,transparent)]"
          : "text-muted-foreground hover:text-foreground hover:bg-white/5",
        isDragging && "shadow-md",
      )}
      title={sessionName ?? undefined}
      onMouseEnter={() => { setIsHovered(true); }}
      onMouseLeave={() => { setIsHovered(false); }}
      onClick={() => { onClick(tab.id); }}
      onDragStart={() => setDraggedTabId?.(tab.id)}
      onDragEnd={() => setDraggedTabId?.(null)}
    >
      {/* Type icon. On a chat tab with a known account this is the merged
          glyph — the bubble carries the account's colour and icon, and the
          separate chip below is dropped. Every other tab type keeps the plain
          icon: there is no chat bubble to merge an account into. */}
      <div className="flex-shrink-0">
        {tab.type === 'chat' && accountName ? (
          <AccountTabGlyph
            name={accountName}
            icon={tab.accountIcon}
            color={tab.accountColor}
            active={isActive}
          />
        ) : (
          <Icon className={cn("w-[15px] h-[15px]", isActive ? "opacity-100" : "opacity-65")} />
        )}
      </div>

      {/* Project name over the session's own name. The project name is never
          truncated (the tab sizes to content); the session name is, because a
          CLI-generated title runs to a full sentence and would otherwise set
          the width of the whole tab. The hover text carries the full one. */}
      <span className="flex-1 min-w-0 flex flex-col justify-center leading-tight">
        <span className="whitespace-nowrap font-medium">{tab.title}</span>
        {!compact && sessionName && (
          <span
            data-testid="tab-session-name"
            className="truncate max-w-[190px] text-[11px] font-normal text-muted-foreground"
          >
            {sessionName}
          </span>
        )}
      </span>

      {/* Account chip — only on non-chat tabs. On a chat tab the glyph above
          already carries the account's colour and icon. */}
      {accountName && tab.type !== 'chat' && (
        <AccountBadge
          name={accountName}
          icon={tab.accountIcon}
          color={tab.accountColor}
          variant="compact"
        />
      )}

      {/* Status indicator slot — min width keeps tab layout stable when empty,
          but grows for larger glyph sizes or the bordered chip. */}
      <div className="flex items-center justify-center min-w-4 flex-shrink-0">
        {statusIcon}
        {tab.hasUnsavedChanges && !statusIcon && (
          <span
            className="w-1.5 h-1.5 bg-primary rounded-full"
            title="Unsaved changes"
          />
        )}
      </div>

      {/* Close button */}
      <button
        aria-label={`Close tab ${tab.title}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        className={cn(
          "flex-shrink-0 w-[14px] h-[14px] flex items-center justify-center rounded-sm",
          "transition-all duration-100 hover:bg-destructive/20 hover:text-destructive",
          "focus:outline-none focus:ring-1 focus:ring-destructive/50",
          isHovered || isActive ? "opacity-50" : "opacity-0",
          "hover:opacity-100",
        )}
        title={`Close ${tab.title}`}
        tabIndex={-1}
      >
        <X className="w-3 h-3" />
      </button>
    </Reorder.Item>
  );
};

interface TabManagerProps {
  className?: string;
}

export const TabManager: React.FC<TabManagerProps> = ({ className }) => {
  useRenderProfile('TabManager');
  const {
    tabs,
    activeTabId,
    createProjectsTab,
    closeTab,
    switchToTab,
    canAddTab
  } = useTabState();

  // Access reorderTabs from context
  const { reorderTabs } = useTabContext();

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showLeftScroll, setShowLeftScroll] = useState(false);
  const [showRightScroll, setShowRightScroll] = useState(false);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  // Tab awaiting a "you're about to kill a running session" confirmation.
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  // The keyboard effect is registered once and must not re-subscribe every
  // time `tabs` changes, so it reaches the current close handler through a
  // ref rather than a dependency. Same ref-capture pattern the tab callbacks
  // use elsewhere — see the note in TabContext.updateTab.
  const handleCloseTabRef = useRef<(id: string) => Promise<void>>(
    async () => { /* replaced below on first render */ },
  );

  // Listen for tab switch events
  useEffect(() => {
    const handleSwitchToTab = (event: CustomEvent) => {
      const { tabId } = event.detail;
      switchToTab(tabId);
    };

    window.addEventListener('switch-to-tab', handleSwitchToTab as EventListener);
    return () => {
      window.removeEventListener('switch-to-tab', handleSwitchToTab as EventListener);
    };
  }, [switchToTab]);

  // Listen for keyboard shortcut events
  useEffect(() => {
    const handleCreateTab = () => {
      createProjectsTab();
    };

    // ⌘W goes through the same guard as the × — a keyboard shortcut is the
    // easier of the two to fire by accident.
    const handleCloseTab = () => {
      if (activeTabId) {
        void handleCloseTabRef.current(activeTabId);
      }
    };

    const handleNextTab = () => {
      const currentIndex = tabs.findIndex(tab => tab.id === activeTabId);
      const nextIndex = (currentIndex + 1) % tabs.length;
      if (tabs[nextIndex]) {
        switchToTab(tabs[nextIndex].id);
      }
    };

    const handlePreviousTab = () => {
      const currentIndex = tabs.findIndex(tab => tab.id === activeTabId);
      const previousIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
      if (tabs[previousIndex]) {
        switchToTab(tabs[previousIndex].id);
      }
    };

    const handleTabByIndex = (event: CustomEvent) => {
      const { index } = event.detail;
      if (tabs[index]) {
        switchToTab(tabs[index].id);
      }
    };

    // handleCloseTab is async; wrap once via fireAndLog and pin the
    // reference so add/removeEventListener see the same fn (otherwise
    // the remove-pair never fires and the listener leaks on unmount).
    const wrappedClose = fireAndLog('tab-manager:close-current', handleCloseTab);
    window.addEventListener('create-chat-tab', handleCreateTab);
    window.addEventListener('close-current-tab', wrappedClose);
    window.addEventListener('switch-to-next-tab', handleNextTab);
    window.addEventListener('switch-to-previous-tab', handlePreviousTab);
    window.addEventListener('switch-to-tab-by-index', handleTabByIndex as EventListener);

    return () => {
      window.removeEventListener('create-chat-tab', handleCreateTab);
      window.removeEventListener('close-current-tab', wrappedClose);
      window.removeEventListener('switch-to-next-tab', handleNextTab);
      window.removeEventListener('switch-to-previous-tab', handlePreviousTab);
      window.removeEventListener('switch-to-tab-by-index', handleTabByIndex as EventListener);
    };
  }, [tabs, activeTabId, createProjectsTab, closeTab, switchToTab]);

  // Check scroll buttons visibility
  const checkScrollButtons = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    setShowLeftScroll(scrollLeft > 0);
    setShowRightScroll(scrollLeft + clientWidth < scrollWidth - 1);
  };

  useEffect(() => {
    checkScrollButtons();
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener('scroll', checkScrollButtons);
    window.addEventListener('resize', checkScrollButtons);

    return () => {
      container.removeEventListener('scroll', checkScrollButtons);
      window.removeEventListener('resize', checkScrollButtons);
    };
  }, [tabs]);

  const handleReorder = (newOrder: Tab[]) => {
    // Opens a profiling window per drag crossing. `reorderTabs` renumbers by
    // rebuilding every tab object, so this is the interaction we most need a
    // number for — it fires once per neighbour passed, not once per drag.
    renderProfiler.profile('tab-reorder');
    // Find the positions that changed
    const oldOrder = tabs.map(tab => tab.id);
    const newOrderIds = newOrder.map(tab => tab.id);
    
    // Find what moved
    const movedTabId = newOrderIds.find((id, index) => oldOrder[index] !== id);
    if (!movedTabId) return;
    
    const oldIndex = oldOrder.indexOf(movedTabId);
    const newIndex = newOrderIds.indexOf(movedTabId);
    
    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      // Use the context's reorderTabs function
      reorderTabs(oldIndex, newIndex);
    }
  };

  /**
   * Every user-initiated close funnels through here — the × and ⌘W both.
   *
   * Closing a tab is the only thing that tears down the main-process CLI
   * session (`TabContext.removeTab` → `api.stopSession`), and it is not
   * recoverable: the turn in flight is lost. So a tab with live work asks
   * first. Everything else closes as before — a confirmation on every tab
   * would train the reflex that makes the prompt useless on the one that
   * matters.
   */
  const handleCloseTab = async (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab && tabCloseNeedsConfirm(tab, Date.now())) {
      setPendingCloseId(id);
      return;
    }
    await closeTab(id);
  };

  handleCloseTabRef.current = handleCloseTab;

  const pendingCloseTab = pendingCloseId
    ? tabs.find((t) => t.id === pendingCloseId)
    : undefined;

  // `force` skips the unsaved-changes prompt in useTabState.closeTab: the user
  // has already answered the harder question about this tab.
  const confirmPendingClose = async () => {
    const id = pendingCloseId;
    setPendingCloseId(null);
    if (id) await closeTab(id, true);
  };

  const handleNewTab = () => {
    if (canAddTab()) {
      createProjectsTab();
    }
  };

  // Wraps the plain switch so a click is measured end to end: the profiler
  // window opens before setActiveTabId and closes after the resulting paint,
  // which is exactly the interval that feels laggy.
  const handleSwitchToTab = (id: string) => {
    renderProfiler.profile('tab-switch');
    switchToTab(id);
  };

  const scrollTabs = (direction: 'left' | 'right') => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrollAmount = 200;
    const newScrollLeft = direction === 'left'
      ? container.scrollLeft - scrollAmount
      : container.scrollLeft + scrollAmount;

    container.scrollTo({
      left: newScrollLeft,
      behavior: 'smooth'
    });
  };

  return (
    <div className={cn("flex items-stretch bg-muted/40 relative border-b border-border/50", className)}>
      {/* Left fade gradient */}
      {showLeftScroll && (
        <div className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-muted/40 to-transparent pointer-events-none z-10" />
      )}
      
      {/* Left scroll button */}
      <AnimatePresence>
        {showLeftScroll && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { scrollTabs('left'); }}
            className={cn(
              "p-1.5 hover:bg-muted/80 rounded-sm z-20 ml-1",
              "transition-colors duration-200 flex items-center justify-center",
              "bg-background/80 backdrop-blur-sm shadow-sm border border-border/50"
            )}
            title="Scroll tabs left"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M15 18l-6-6 6-6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Tabs container */}
      <div
        ref={scrollContainerRef}
        className="flex-1 flex overflow-x-auto scrollbar-hide"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {/* No fixed height here: the tabs set it. This row was pinned at `h-9`
            (36px) from when a tab was a single 26px line, so the two-line 38px
            tab overflowed it by a pixel top and bottom and the scroll
            container clipped the result. Padding instead, so the strip grows
            with whatever the tab is. */}
        <div className="flex items-center gap-1 px-2 py-1">
          {/* The dragged tab used to blank for a frame on each crossing. It
              was not framer-motion and not StrictMode — both were blamed and
              both were wrong. `onReorder` fires per crossing, and nothing in
              the panel tree below was memoised, so every crossing re-rendered
              every open session's full unvirtualised transcript (measured:
              ~1400 rows, ~110ms) between the drag frames. StrictMode's
              double-invoke made it obvious in dev, which is why it looked
              dev-only; it was always there, just cheaper to miss.
              Fixed by memoising TabPanel and ClaudeTranscript. If it ever
              returns, measure with `__omnifexProfile.on()` before theorising —
              see src/lib/renderProfiler.ts. */}
          <Reorder.Group
            axis="x"
            values={tabs}
            onReorder={handleReorder}
            className="flex items-center gap-1"
            // The parent .flex-1 div is `overflow-x-auto`, so let framer-motion
            // do scroll-aware layout math when the dragged tab nears the edge.
            // Setting `layoutScroll={false}` was making drop targets
            // mis-compute and contributed to the jumpy reorder.
            layoutScroll
          >
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
                onClose={fireAndLog('tab-manager:close', handleCloseTab)}
                onClick={handleSwitchToTab}
                isDragging={draggedTabId === tab.id}
                setDraggedTabId={setDraggedTabId}
              />
            ))}
          </Reorder.Group>
          
          {/* New tab button - positioned right after tabs */}
          <motion.button
            onClick={handleNewTab}
            disabled={!canAddTab()}
            whileTap={canAddTab() ? { scale: 0.97 } : {}}
            transition={{ duration: 0.15 }}
            className={cn(
              "px-2 rounded-md flex items-center justify-center flex-shrink-0",
              "bg-background/50 backdrop-blur-sm h-[38px]",
              "shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_75%,transparent)]",
              canAddTab()
                ? "hover:bg-muted/60 text-muted-foreground hover:text-foreground"
                : "opacity-50 cursor-not-allowed text-muted-foreground"
            )}
            title={canAddTab() ? "New project (Ctrl+T)" : "Maximum tabs reached"}
          >
            <Plus className="w-4 h-4" />
          </motion.button>
        </div>
      </div>

      {/* Right fade gradient */}
      {showRightScroll && (
        <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-muted/40 to-transparent pointer-events-none z-10" />
      )}

      {/* Right scroll button */}
      <AnimatePresence>
        {showRightScroll && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { scrollTabs('right'); }}
            className={cn(
              "p-1.5 hover:bg-muted/80 rounded-sm z-20 mr-1",
              "transition-colors duration-200 flex items-center justify-center",
              "bg-background/80 backdrop-blur-sm shadow-sm border border-border/50"
            )}
            title="Scroll tabs right"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M9 18l6-6-6-6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Closing a tab stops its CLI session, and the turn in flight does not
          survive it. Only shown for tabs with live work — see
          tabCloseNeedsConfirm. */}
      <Dialog
        open={pendingCloseId !== null}
        onOpenChange={(open) => { if (!open) setPendingCloseId(null); }}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Stop this session?</DialogTitle>
            <DialogDescription>
              {pendingCloseTab
                ? `"${pendingCloseTab.title}" is still working. Closing the tab stops the session — the turn in progress is lost and cannot be resumed.`
                : 'This session is still working. Closing the tab stops it.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setPendingCloseId(null); }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={fireAndLog('tab-manager:confirm-close', confirmPendingClose)}
            >
              Stop and close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TabManager;