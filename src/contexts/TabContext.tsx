import React, { createContext, useState, useContext, useCallback, useEffect, useRef, useMemo } from 'react';
import { TabPersistenceService } from '@/services/tabPersistence';
import { SessionPersistenceService } from '@/services/sessionPersistence';
import { sessionNameRegistry } from '@/services/sessionNameRegistry';
import { api, type AgentKind } from '@/lib/api';
import type { TabWaitingFor } from '@/lib/tabWaitingFor';
import { logAndForget } from "@/lib/fireAndLog";

export interface Tab {
  id: string;
  type: 'chat' | 'projects' | 'mcp' | 'settings' | 'claude-md' | 'claude-file' | 'lima' | 'brain' | 'cost-report';
  title: string;
  agent: AgentKind;
  sessionId?: string;
  sessionData?: any;
  claudeFileId?: string;
  initialProjectPath?: string;
  returnToProjectPath?: string;
  /** Sent once the auto-started session is up, then cleared so a restored tab never re-sends. */
  initialPrompt?: string;
  initialSessionConfig?: {
    model: string;
    effort: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    permissionMode: string;
    /** Seeds accountResolution instead of re-resolving, so the session spawns under the chosen account even when not persisted. */
    accountResolution?: {
      account: {
        name: string;
        subscription_label: string;
        has_cost: boolean;
        config_dir: string;
        session_defaults?: import('@/lib/api').SessionDefaults;
      };
      match_type: string;
      match_detail: string;
    };
  };
  projectPath?: string;
  accountName?: string;
  accountColor?: string | null;
  accountIcon?: string | null;
  status: 'active' | 'idle' | 'running' | 'complete' | 'error';
  promptStatus?: 'working' | 'ready';
  /** Outranks the working spinner: a background agent outlives the turn that launched it. */
  activeAgents?: number;
  waitingFor?: TabWaitingFor;
  /** `cacheTtlMs` is the TTL the CLI actually used (usage.cache_creation). TabManager owns the clock. */
  cacheAnchorMs?: number | null;
  cacheTtlMs?: number | null;
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
  getTabsByType: (type: 'chat') => Tab[];
}

const TabContext = createContext<TabContextType | undefined>(undefined);

const MAX_TABS = 20;

function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function makeDefaultTab(type: Tab['type'], title: string): Tab {
  return {
    id: generateTabId(),
    type,
    title,
    agent: 'claude',
    status: 'idle',
    hasUnsavedChanges: false,
    order: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

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
  const saveTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  // Lookups read tabs through a ref: a tabs dependency cascades new references through useTabState into infinite loops.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    const loadTabs = async () => {
    if (isInitialized.current) return;
    isInitialized.current = true;

    TabPersistenceService.migrateFromOldFormat();

    const { tabs: savedTabs, activeTabId: savedActiveTabId } = TabPersistenceService.loadTabs();
    
    if (savedTabs.length > 0) {
      const restoredTabs = await Promise.all(savedTabs.map(async (tab) => {
        if (tab.type === 'chat' && tab.sessionId) {
          const sessionData = SessionPersistenceService.loadSession(tab.sessionId);
          if (sessionData) {
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
      let defaultType: Tab['type'] = 'projects';
      let defaultTitle = 'Projects';
      try {
        const accounts = await api.listAccounts();
        if (accounts.length === 0) {
          defaultType = 'settings';
          defaultTitle = 'Settings';
        }
      } catch {
        // Fall back to Projects.
      }

      const defaultTab = makeDefaultTab(defaultType, defaultTitle);
      setTabs([defaultTab]);
      setActiveTabId(defaultTab.id);
    }
    };
    
    logAndForget('tab-context:load-tabs', loadTabs());
  }, []);

  useEffect(() => {
    if (!isInitialized.current) return;
    
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      TabPersistenceService.saveTabs(tabs, activeTabId);
    }, 500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [tabs, activeTabId]);

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

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isInitialized.current && tabs.length > 0) {
        TabPersistenceService.saveTabs(tabs, activeTabId);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (isInitialized.current && tabs.length > 0) {
        TabPersistenceService.saveTabs(tabs, activeTabId);
      }
    };
  }, [tabs, activeTabId]);

  const addTab = useCallback((tabData: Omit<Tab, 'id' | 'order' | 'createdAt' | 'updatedAt'>): string => {
    if (tabs.length >= MAX_TABS) {
      throw new Error(`Maximum number of tabs (${MAX_TABS}) reached`);
    }

    const newTab: Tab = {
      ...tabData,
      id: generateTabId(),
      // Placeholder: the real index is assigned in the updater; a render-time snapshot gave batched adds the same `order`.
      order: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    setTabs(prevTabs => [...prevTabs, { ...newTab, order: prevTabs.length }]);
    setActiveTabId(newTab.id);
    return newTab.id;
  }, [tabs.length]);

  const removeTab = useCallback((id: string) => {
    // Built outside the updater so a StrictMode double-invoke reuses one id.
    const replacementTab = makeDefaultTab('projects', 'Projects');
    setTabs(prevTabs => {
      const removedTab = prevTabs.find(tab => tab.id === id);
      const filteredTabs = prevTabs.filter(tab => tab.id !== id);
      // A lone Projects tab would only be swapped for another, resetting its search, sort and scroll.
      if (filteredTabs.length === 0 && removedTab?.type === 'projects') return prevTabs;

      const reorderedTabs = filteredTabs.length > 0
        ? filteredTabs.map((tab, index) => ({ ...tab, order: index }))
        : [replacementTab];

      if (filteredTabs.length === 0) {
        setActiveTabId(replacementTab.id);
      } else if (activeTabId === id) {
        const removedTabIndex = prevTabs.findIndex(tab => tab.id === id);
        const newActiveIndex = Math.min(removedTabIndex, reorderedTabs.length - 1);
        setActiveTabId(reorderedTabs[newActiveIndex].id);
      }

      // Only tab close ends a CLI session, never unmount (reload, StrictMode) — rebind must be able to claim it.
      // Even close only releases: the daemon stops it when no client holds it.
      if (removedTab?.type === 'chat') {
        logAndForget(
          `tab-context:release-session-on-close:${id}`,
          api.releaseSession(id),
        );
      }

      return reorderedTabs;
    });
  }, [activeTabId]);

  const updateTab = useCallback((id: string, updates: Partial<Tab>) => {
    setTabs(prevTabs => {
      let changed = false;
      const nextTabs = prevTabs.map(tab => {
        if (tab.id !== id) return tab;
        // Same reference when nothing differs, so an unstable caller cannot become a render loop.
        const keys = Object.keys(updates) as (keyof Tab)[];
        const allEqual = keys.every((k) => tab[k] === updates[k]);
        if (allEqual) return tab;
        changed = true;
        return { ...tab, ...updates, updatedAt: new Date() };
      });
      return changed ? nextTabs : prevTabs;
    });
  }, []);

  const setActiveTab = useCallback((id: string) => {
    if (tabsRef.current.find(tab => tab.id === id)) {
      setActiveTabId(id);
      setTabs(prev => prev.map(tab =>
        tab.id === id && tab.hasUnreadResult
          ? { ...tab, hasUnreadResult: false }
          : tab
      ));
    }
  }, []);

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
      if (startIndex === endIndex) return prevTabs;
      if (startIndex < 0 || startIndex >= prevTabs.length) return prevTabs;

      const newTabs = [...prevTabs];
      const [removed] = newTabs.splice(startIndex, 1);
      newTabs.splice(endIndex, 0, removed);

      // Re-create only the tabs that moved: rebuilding all N defeats TabPanel's memo and re-renders every
      // transcript per drag crossing. Decide the move by indices, not by changed `order` fields — drifted
      // fields would swallow a real move.
      return newTabs.map((tab, index) =>
        tab.order === index ? tab : { ...tab, order: index },
      );
    });
  }, []);

  const getTabById = useCallback((id: string): Tab | undefined => {
    return tabsRef.current.find(tab => tab.id === id);
  }, []);

  const getTabsByType = useCallback((type: 'chat'): Tab[] => {
    return tabsRef.current.filter(tab => tab.type === type);
  }, []);

  // Memoized: every stream-driven updateTab would otherwise re-render every consumer.
  const value: TabContextType = useMemo(() => ({
    tabs,
    activeTabId,
    addTab,
    removeTab,
    updateTab,
    setActiveTab,
    reorderTabs,
    getTabById,
    getTabsByType
  }), [tabs, activeTabId, addTab, removeTab, updateTab, setActiveTab, reorderTabs, getTabById, getTabsByType]);

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
