import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { X, Plus, MessageSquare, Folder, Server, Settings, FileText, HardDrive, List, Brain, DollarSign } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { TabStatusGlyph } from '@/components/TabStatusGlyph';
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

// Unknown override ids fall through to the type default, so a stale persisted value can't break the strip.
const TAB_ICON_OVERRIDES: Record<string, typeof MessageSquare> = {
  list: List,
};

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

export function resolveTabStatusIndicator(
  tab: Tab,
  nowMs: number,
): TabStatusIndicator | null {
  if (tab.status === 'error') return { kind: 'error' };
  // Waiting on the human outranks busy: a pending permission keeps the turn open.
  if (tab.waitingFor === 'permission') return { kind: 'permission' };
  if (tab.waitingFor === 'question') return { kind: 'question' };
  // Running agents outrank the spinner: a backgrounded agent's launching turn is already over.
  if (tab.activeAgents && tab.activeAgents > 0) {
    return { kind: 'agents', count: tab.activeAgents };
  }
  if (tab.promptStatus === 'working' || (!tab.promptStatus && tab.status === 'running')) {
    return { kind: 'spinner' };
  }
  if (tab.hasUnreadResult) return { kind: 'complete' };
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

const LIVE_WORK_KINDS: ReadonlySet<TabStatusIndicator['kind']> = new Set([
  'spinner',
  'agents',
  'permission',
  'question',
]);

// Derived from resolveTabStatusIndicator on purpose: `error` outranking all keeps dead sessions from
// prompting, and `hasUnreadResult` ranking below working keeps finished turns from prompting.
export function tabCloseNeedsConfirm(tab: Tab, nowMs: number): boolean {
  const indicator = resolveTabStatusIndicator(tab, nowMs);
  return indicator !== null && LIVE_WORK_KINDS.has(indicator.kind);
}

const TabItem: React.FC<TabItemProps> = ({ tab, isActive, onClose, onClick, isDragging = false, setDraggedTabId }) => {
  useRenderProfile('TabItem');
  const [isHovered, setIsHovered] = useState(false);
  const { config } = useMessageRenderingConfig();
  const compact = config.tabs.density === 'compact';
  const accountName = tab.accountName;
  const sessionName = useTabSessionTitle(tab.id);

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
    switch (indicator?.kind) {
      case 'error':
        return <TabStatusGlyph style={ind.error} indicators={ind} ariaLabel="Error" />;
      case 'permission':
        return <TabStatusGlyph style={ind.permission} indicators={ind} ariaLabel="Permission request" />;
      case 'question':
        return <TabStatusGlyph style={ind.question} indicators={ind} ariaLabel="Question waiting" />;
      case 'spinner':
        return <Spinner className="size-3.5" />;
      case 'agents':
        return <AgentCountGlyph count={indicator.count} />;
      case 'complete':
        return <TabStatusGlyph style={ind.complete} indicators={ind} ariaLabel="Completed" />;
      case 'cacheExpiring':
        return (
          <TabStatusGlyph
            style={ind.cacheExpiring}
            indicators={ind}
            ariaLabel={indicator.critical ? "Prompt cache about to expire" : "Prompt cache expiring soon"}
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
      data-tab-id={tab.id}
      dragListener={true}
      // No CSS transform transition: framer-motion animates transform during the drag.
      whileDrag={{ scale: 1.02, zIndex: 30, cursor: 'grabbing' }}
      className={cn(
        "relative flex items-center gap-[7px] text-[15px] cursor-pointer select-none group",
        "transition-colors duration-100",
        "rounded-md px-[10px]",
        compact ? "h-[30px]" : "h-[38px]",
        "min-w-[120px] w-max shrink-0",
        isActive
          ? "text-foreground bg-background shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_75%,transparent)]"
          : "text-muted-foreground hover:text-foreground hover:bg-white/5",
        isDragging && "shadow-md",
      )}
      style={{ maxWidth: config.tabs.maxWidth }}
      title={sessionName ?? undefined}
      onMouseEnter={() => { setIsHovered(true); }}
      onMouseLeave={() => { setIsHovered(false); }}
      onClick={() => { onClick(tab.id); }}
      onDragStart={() => setDraggedTabId?.(tab.id)}
      onDragEnd={() => setDraggedTabId?.(null)}
    >
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

      <span className="flex-1 min-w-0 flex flex-col justify-center leading-tight">
        <span data-testid="tab-project-name" className="truncate font-medium">{tab.title}</span>
        {!compact && sessionName && (
          <span
            data-testid="tab-session-name"
            className="truncate text-[11px] font-normal text-muted-foreground"
          >
            {sessionName}
          </span>
        )}
      </span>

      {accountName && tab.type !== 'chat' && (
        <AccountBadge
          name={accountName}
          icon={tab.accountIcon}
          color={tab.accountColor}
          variant="compact"
        />
      )}

      <div className="flex items-center justify-center min-w-4 flex-shrink-0">
        {statusIcon}
        {tab.hasUnsavedChanges && !statusIcon && (
          <span
            className="w-1.5 h-1.5 bg-primary rounded-full"
            title="Unsaved changes"
          />
        )}
      </div>

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

/** Matches the `w-8` edge fades. */
export const TAB_REVEAL_MARGIN_PX = 32;

function footprint(el: HTMLElement | null): number {
  if (!el) return 0;
  const style = getComputedStyle(el);
  return el.getBoundingClientRect().width
    + (parseFloat(style.marginLeft) || 0)
    + (parseFloat(style.marginRight) || 0);
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

  const { reorderTabs } = useTabContext();

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showLeftScroll, setShowLeftScroll] = useState(false);
  const [showRightScroll, setShowRightScroll] = useState(false);
  const leftScrollRef = useRef<HTMLButtonElement>(null);
  const rightScrollRef = useRef<HTMLButtonElement>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  // Ref so the keyboard listener always reaches the current close handler.
  const handleCloseTabRef = useRef<(id: string) => Promise<void>>(
    async () => {},
  );

  useEffect(() => {
    const handleSwitchToTab = (event: CustomEvent<{ tabId: string }>) => {
      const { tabId } = event.detail;
      switchToTab(tabId);
    };

    window.addEventListener('switch-to-tab', handleSwitchToTab as EventListener);
    return () => {
      window.removeEventListener('switch-to-tab', handleSwitchToTab as EventListener);
    };
  }, [switchToTab]);

  useEffect(() => {
    const handleCreateTab = () => {
      createProjectsTab();
    };

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

    const handleTabByIndex = (event: CustomEvent<{ index: number }>) => {
      const { index } = event.detail;
      if (tabs[index]) {
        switchToTab(tabs[index].id);
      }
    };

    // Wrapped once so add/removeEventListener see the same function.
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

  // Measure with the arrows' width given back, or a mounted arrow keeps itself up.
  const checkScrollButtons = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    const reclaimable = footprint(leftScrollRef.current) + footprint(rightScrollRef.current);
    if (clientWidth + reclaimable >= scrollWidth - 1) {
      setShowLeftScroll(false);
      setShowRightScroll(false);
      return;
    }
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
    renderProfiler.profile('tab-reorder');
    const oldOrder = tabs.map(tab => tab.id);
    const newOrderIds = newOrder.map(tab => tab.id);
    
    const movedTabId = newOrderIds.find((id, index) => oldOrder[index] !== id);
    if (!movedTabId) return;
    
    const oldIndex = oldOrder.indexOf(movedTabId);
    const newIndex = newOrderIds.indexOf(movedTabId);
    
    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      reorderTabs(oldIndex, newIndex);
    }
  };

  // Only tabs with live work confirm; confirming every close trains the reflex that defeats it.
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

  // `force` skips the unsaved-changes prompt: the user already confirmed.
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

  const handleSwitchToTab = (id: string) => {
    renderProfiler.profile('tab-switch');
    switchToTab(id);
    // Re-clicking the active tab doesn't fire the reveal effect.
    revealTab(id);
  };

  const revealTab = (id: string) => {
    const container = scrollContainerRef.current;
    const el = Array.from(container?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])
      .find((node) => node.dataset.tabId === id);
    if (!container || !el) return;
    const strip = container.getBoundingClientRect();
    const tab = el.getBoundingClientRect();
    let delta = 0;
    if (tab.left < strip.left + TAB_REVEAL_MARGIN_PX) {
      delta = tab.left - strip.left - TAB_REVEAL_MARGIN_PX;
    } else if (tab.right > strip.right - TAB_REVEAL_MARGIN_PX) {
      delta = tab.right - strip.right + TAB_REVEAL_MARGIN_PX;
    }
    const left = Math.max(0, container.scrollLeft + delta);
    followActiveRef.current = true;
    if (left === container.scrollLeft) return;
    container.scrollTo({ left, behavior: 'smooth' });
  };

  useEffect(() => {
    if (activeTabId) revealTab(activeTabId);
  }, [activeTabId]);

  // Re-reveal on resize until the user scrolls: a mounting arrow narrows the strip mid-reveal, and a
  // tab widens when its title arrives from a store (hence the row is observed too).
  const followActiveRef = useRef(false);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const revealTabRef = useRef(revealTab);
  revealTabRef.current = revealTab;
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      checkScrollButtons();
      const id = activeTabIdRef.current;
      if (followActiveRef.current && id) revealTabRef.current(id);
    });
    observer.observe(container);
    const row = container.firstElementChild;
    if (row) observer.observe(row);
    const stopFollowing = () => { followActiveRef.current = false; };
    container.addEventListener('wheel', stopFollowing, { passive: true });
    return () => {
      observer.disconnect();
      container.removeEventListener('wheel', stopFollowing);
    };
  }, []);

  const scrollTabs = (direction: 'left' | 'right') => {
    const container = scrollContainerRef.current;
    if (!container) return;
    followActiveRef.current = false;

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
      <AnimatePresence>
        {showLeftScroll && (
          <motion.button
            ref={leftScrollRef}
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

      <div className="relative flex min-w-0">
        {showLeftScroll && (
          <div className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-muted/40 to-transparent pointer-events-none z-10" />
        )}
        {showRightScroll && (
          <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-muted/40 to-transparent pointer-events-none z-10" />
        )}
        <div
          ref={scrollContainerRef}
          data-testid="tab-strip-scroll"
          className="flex min-w-0 overflow-x-auto scrollbar-hide"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {/* No fixed height: the tabs set it, and a fixed row clipped the two-line tab. */}
          <div data-testid="tab-strip-content" className="flex items-center gap-1 pl-2 pr-1 py-1">
            {/* onReorder fires per crossing: TabPanel and ClaudeTranscript must stay memoised, or every
                open transcript re-renders on each one (the drag-flash bug). */}
            <Reorder.Group
              axis="x"
              values={tabs}
              onReorder={handleReorder}
              className="flex items-center gap-1"
              // Needed inside the overflow-x container, or drop targets mis-compute.
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
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showRightScroll && (
          <motion.button
            ref={rightScrollRef}
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

      <div className="flex items-center py-1 pr-2">
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