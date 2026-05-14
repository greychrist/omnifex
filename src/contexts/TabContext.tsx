import React, { createContext, useState, useContext, useCallback, useEffect, useRef } from 'react';
import { TabPersistenceService } from '@/services/tabPersistence';
import { SessionPersistenceService } from '@/services/sessionPersistence';
import { sessionNameRegistry } from '@/services/sessionNameRegistry';
import { api } from '@/lib/api';
import { logAndForget } from "@/lib/fireAndLog";

export interface Tab {
  id: string;
  type: 'chat' | 'projects' | 'usage' | 'mcp' | 'settings' | 'claude-md' | 'claude-file' | 'lima';
  title: string;
  sessionId?: string;  // for chat tabs
  sessionData?: any; // for chat tabs - stores full session object
  claudeFileId?: string; // for claude-file tabs
  initialProjectPath?: string; // for chat tabs
  /**
   * Pre-filled session configuration for a chat tab that was started from
   * the project view's inline new-session form. ClaudeCodeSession seeds its
   * state with these values and auto-starts the session, so the user doesn't
   * have to click "Start Session" again.
   */
  initialSessionConfig?: {
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    thinkingConfig?: 'adaptive' | 'disabled';
    permissionMode: string;
    /**
     * Account override selected by the user on the project landing page.
     * When present, ClaudeCodeSession seeds its accountResolution from this
     * snapshot instead of re-resolving from the auto-rules — guarantees the
     * session spawns under the chosen account even when the override wasn't
     * persisted via "Remember for this project".
     */
    accountResolution?: {
      account: {
        name: string;
        account_type: string;
        config_dir: string;
        session_defaults?: import('@/lib/api').SessionDefaults;
      };
      match_type: string;
      match_detail: string;
    };
  };
  projectPath?: string; // for chat tabs
  accountName?: string; // for chat tabs - resolved account name
  accountColor?: string | null;  // for chat tabs - resolved account color
  accountIcon?: string | null;   // for chat tabs - resolved account icon
  status: 'active' | 'idle' | 'running' | 'complete' | 'error';
  hasUnsavedChanges: boolean;
  hasUnreadResult?: boolean;
  order: number;
  icon?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface TabContextType {
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (tab: Omit<Tab, 'id' | 'order' | 'createdAt' | 'updatedAt'>) => string;
  removeTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<Tab>) => void;
  setActiveTab: (id: string) => void;
  reorderTabs: (startIndex: number, endIndex: number) => void;
  getTabById: (id: string) => Tab | undefined;
  closeAllTabs: () => void;
  getTabsByType: (type: 'chat') => Tab[];
}

const TabContext = createContext<TabContextType | undefined>(undefined);

// const STORAGE_KEY = 'greychrist_tabs'; // No longer needed - persistence disabled
const MAX_TABS = 20;

/**
 * Last non-empty path segment of an absolute project path. Strips trailing
 * slashes and accepts both POSIX and Windows separators. Returns undefined
 * for paths that resolve to nothing meaningful (empty string, "/", "//").
 * Used by the session-name registry mirror so the Log tab can render
 * `session: <project> - <guid7>` even after the tab is closed.
 */
function projectBasename(p: string | null | undefined): string | undefined {
  if (!p) return undefined;
  const trimmed = String(p).replace(/[/\\]+$/, '');
  if (!trimmed) return undefined;
  const seg = trimmed.split(/[/\\]/).pop();
  return seg && seg.length > 0 ? seg : undefined;
}

export const TabProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const isInitialized = useRef(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout>();
  // Stable ref for tabs — used by lookup functions so they don't need
  // tabs in their dependency arrays (which would cascade new references
  // through useTabState on every tabs change and cause infinite loops).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Load tabs from storage on mount
  useEffect(() => {
    const loadTabs = async () => {
    if (isInitialized.current) return;
    isInitialized.current = true;

    // Migrate from old format if needed
    TabPersistenceService.migrateFromOldFormat();

    // Try to load saved tabs
    const { tabs: savedTabs, activeTabId: savedActiveTabId } = TabPersistenceService.loadTabs();
    
    if (savedTabs.length > 0) {
      // For chat tabs, restore session data
      const restoredTabs = await Promise.all(savedTabs.map(async (tab) => {
        if (tab.type === 'chat' && tab.sessionId) {
          // Check if session can be restored
          const sessionData = SessionPersistenceService.loadSession(tab.sessionId);
          if (sessionData) {
            // Create a Session object for the tab
            const session = SessionPersistenceService.createSessionFromRestoreData(sessionData);
            return {
              ...tab,
              sessionData: session,
              initialProjectPath: sessionData.projectPath
            };
          }
        }
        return tab;
      }));
      
      setTabs(restoredTabs);
      setActiveTabId(savedActiveTabId);
    } else {
      // Check if any accounts exist — if not, default to Settings
      let defaultType: Tab['type'] = 'projects';
      let defaultTitle = 'Projects';
      try {
        const accounts = await api.listAccounts();
        if (accounts.length === 0) {
          defaultType = 'settings';
          defaultTitle = 'Settings';
        }
      } catch {
        // If account check fails, fall back to projects
      }

      const defaultTab: Tab = {
        id: generateTabId(),
        type: defaultType,
        title: defaultTitle,
        status: 'idle',
        hasUnsavedChanges: false,
        order: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      setTabs([defaultTab]);
      setActiveTabId(defaultTab.id);
    }
    };
    
    logAndForget('tab-context:load-tabs', loadTabs());
  }, []);

  // Save tabs to localStorage with debounce
  useEffect(() => {
    // Don't save if not initialized
    if (!isInitialized.current) return;
    
    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce saving to avoid excessive writes
    saveTimeoutRef.current = setTimeout(() => {
      TabPersistenceService.saveTabs(tabs, activeTabId);
    }, 500); // Wait 500ms after last change before saving

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [tabs, activeTabId]);

  // Mirror each chat tab's identifying fields (title, project basename,
  // Claude session id) into the persistent session-name registry so the
  // Log tab's Category column can render `session: <project> - <guid7>`
  // — including for tabs that have since been closed (tab state is
  // in-memory; the registry is the only place a closed tab's identity
  // still lives). The registry merges partial updates, so it's safe to
  // call this each render — fields that aren't known yet (e.g. the
  // sessionId before the SDK has emitted its `init` message) just stay
  // absent until the next render writes them.
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.type !== 'chat') continue;
      const projectName = projectBasename(tab.projectPath);
      sessionNameRegistry.set(tab.id, {
        title: tab.title,
        projectName,
        claudeSessionId: tab.sessionId,
      });
    }
  }, [tabs]);

  // Save tabs immediately when window is about to close
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isInitialized.current && tabs.length > 0) {
        TabPersistenceService.saveTabs(tabs, activeTabId);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // Save one final time when component unmounts
      if (isInitialized.current && tabs.length > 0) {
        TabPersistenceService.saveTabs(tabs, activeTabId);
      }
    };
  }, [tabs, activeTabId]);

  const generateTabId = () => {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  };

  const addTab = useCallback((tabData: Omit<Tab, 'id' | 'order' | 'createdAt' | 'updatedAt'>): string => {
    if (tabs.length >= MAX_TABS) {
      throw new Error(`Maximum number of tabs (${MAX_TABS}) reached`);
    }

    const newTab: Tab = {
      ...tabData,
      id: generateTabId(),
      order: tabs.length,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    setTabs(prevTabs => [...prevTabs, newTab]);
    setActiveTabId(newTab.id);
    return newTab.id;
  }, [tabs.length]);

  const removeTab = useCallback((id: string) => {
    setTabs(prevTabs => {
      const filteredTabs = prevTabs.filter(tab => tab.id !== id);
      
      // Reorder remaining tabs
      const reorderedTabs = filteredTabs.map((tab, index) => ({
        ...tab,
        order: index
      }));

      // Update active tab if necessary
      if (activeTabId === id && reorderedTabs.length > 0) {
        const removedTabIndex = prevTabs.findIndex(tab => tab.id === id);
        const newActiveIndex = Math.min(removedTabIndex, reorderedTabs.length - 1);
        setActiveTabId(reorderedTabs[newActiveIndex].id);
      } else if (reorderedTabs.length === 0) {
        setActiveTabId(null);
      }

      return reorderedTabs;
    });
  }, [activeTabId]);

  const updateTab = useCallback((id: string, updates: Partial<Tab>) => {
    setTabs(prevTabs => 
      prevTabs.map(tab => 
        tab.id === id 
          ? { ...tab, ...updates, updatedAt: new Date() }
          : tab
      )
    );
  }, []);

  const setActiveTab = useCallback((id: string) => {
    if (tabsRef.current.find(tab => tab.id === id)) {
      setActiveTabId(id);
      // Clear unread badge when switching to a tab
      setTabs(prev => prev.map(tab =>
        tab.id === id && tab.hasUnreadResult
          ? { ...tab, hasUnreadResult: false }
          : tab
      ));
    }
  }, []);

  // Route native-notification clicks back to the originating tab.
  // The main process sends `notification-clicked` with `{ tabId }`; if the tab
  // still exists, switch to it. Window focus is already handled in the main
  // process so no extra work is needed here when the tab is gone.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onEvent(
      'notification-clicked',
      (data: unknown) => {
        const tabId = (data as { tabId?: string } | undefined)?.tabId;
        if (!tabId) return;
        if (tabsRef.current.find(tab => tab.id === tabId)) {
          setActiveTab(tabId);
        }
      },
    );
    return unsubscribe;
  }, [setActiveTab]);

  const reorderTabs = useCallback((startIndex: number, endIndex: number) => {
    setTabs(prevTabs => {
      const newTabs = [...prevTabs];
      const [removed] = newTabs.splice(startIndex, 1);
      newTabs.splice(endIndex, 0, removed);
      
      // Update order property
      return newTabs.map((tab, index) => ({
        ...tab,
        order: index
      }));
    });
  }, []);

  const getTabById = useCallback((id: string): Tab | undefined => {
    return tabsRef.current.find(tab => tab.id === id);
  }, []);

  const closeAllTabs = useCallback(() => {
    setTabs([]);
    setActiveTabId(null);
    TabPersistenceService.clearTabs();
  }, []);

  const getTabsByType = useCallback((type: 'chat'): Tab[] => {
    return tabsRef.current.filter(tab => tab.type === type);
  }, []);

  const value: TabContextType = {
    tabs,
    activeTabId,
    addTab,
    removeTab,
    updateTab,
    setActiveTab,
    reorderTabs,
    getTabById,
    closeAllTabs,
    getTabsByType
  };

  return (
    <TabContext.Provider value={value}>
      {children}
    </TabContext.Provider>
  );
};

export const useTabContext = () => {
  const context = useContext(TabContext);
  if (!context) {
    throw new Error('useTabContext must be used within a TabProvider');
  }
  return context;
};
