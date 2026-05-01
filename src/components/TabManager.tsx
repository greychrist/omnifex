import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { X, Plus, MessageSquare, AlertCircle, Folder, BarChart, Server, Settings, FileText, HardDrive } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { AccountBadge } from './AccountBadge';
import { useTabState } from '@/hooks/useTabState';
import { Tab, useTabContext } from '@/contexts/TabContext';
import { cn } from '@/lib/utils';

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onClose: (id: string) => void;
  onClick: (id: string) => void;
  isDragging?: boolean;
  setDraggedTabId?: (id: string | null) => void;
}

const TabItem: React.FC<TabItemProps> = ({ tab, isActive, onClose, onClick, isDragging = false, setDraggedTabId }) => {
  const [isHovered, setIsHovered] = useState(false);
  
  const getIcon = () => {
    switch (tab.type) {
      case 'chat':
        return MessageSquare;
      case 'projects':
        return Folder;
      case 'usage':
        return BarChart;
      case 'mcp':
        return Server;
      case 'lima':
        return HardDrive;
      case 'settings':
        return Settings;
      case 'claude-md':
      case 'claude-file':
        return FileText;
      default:
        return MessageSquare;
    }
  };

  const getStatusIcon = () => {
    // Unread result badge takes priority — pulsing dot for visibility
    if (tab.hasUnreadResult) {
      return (
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
        </span>
      );
    }
    switch (tab.status) {
      case 'running':
        return <Spinner className="size-3" />;
      case 'error':
        return <AlertCircle className="w-3 h-3 text-red-500" />;
      default:
        return null;
    }
  };

  const Icon = getIcon();
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
        "relative flex items-center gap-[7px] text-sm cursor-pointer select-none group",
        "transition-colors duration-100",
        "rounded-md h-[26px] px-[10px]",
        "min-w-[120px] max-w-[220px]",
        isActive
          ? "text-foreground bg-background shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_75%,transparent)]"
          : "text-muted-foreground hover:text-foreground hover:bg-white/5",
        isDragging && "shadow-md",
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onClick(tab.id)}
      onDragStart={() => setDraggedTabId?.(tab.id)}
      onDragEnd={() => setDraggedTabId?.(null)}
    >
      {/* Type icon */}
      <div className="flex-shrink-0">
        <Icon className={cn("w-[15px] h-[15px]", isActive ? "opacity-100" : "opacity-65")} />
      </div>

      {/* Title */}
      <span className="flex-1 truncate font-medium min-w-0">
        {tab.title}
      </span>

      {/* Account chip (compact) */}
      {tab.accountName && (
        <AccountBadge
          name={tab.accountName}
          icon={tab.accountIcon}
          color={tab.accountColor}
          variant="compact"
        />
      )}

      {/* Status indicator (fixed slot) */}
      <div className="flex items-center justify-center w-[14px] flex-shrink-0">
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
  const {
    tabs,
    activeTabId,
    createChatTab,
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

    const handleCloseTab = async () => {
      if (activeTabId) {
        await closeTab(activeTabId);
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

    window.addEventListener('create-chat-tab', handleCreateTab);
    window.addEventListener('close-current-tab', handleCloseTab);
    window.addEventListener('switch-to-next-tab', handleNextTab);
    window.addEventListener('switch-to-previous-tab', handlePreviousTab);
    window.addEventListener('switch-to-tab-by-index', handleTabByIndex as EventListener);

    return () => {
      window.removeEventListener('create-chat-tab', handleCreateTab);
      window.removeEventListener('close-current-tab', handleCloseTab);
      window.removeEventListener('switch-to-next-tab', handleNextTab);
      window.removeEventListener('switch-to-previous-tab', handlePreviousTab);
      window.removeEventListener('switch-to-tab-by-index', handleTabByIndex as EventListener);
    };
  }, [tabs, activeTabId, createChatTab, closeTab, switchToTab]);

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

  const handleCloseTab = async (id: string) => {
    await closeTab(id);
  };

  const handleNewTab = () => {
    if (canAddTab()) {
      createProjectsTab();
    }
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
            onClick={() => scrollTabs('left')}
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
        <div className="flex items-center h-9 gap-1 px-2">
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
                onClose={handleCloseTab}
                onClick={switchToTab}
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
              "bg-background/50 backdrop-blur-sm h-[26px]",
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
            onClick={() => scrollTabs('right')}
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

    </div>
  );
};

export default TabManager;