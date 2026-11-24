import type { Tab } from '@/contexts/TabContext';
import type { AgentKind } from '@/lib/api';

const STORAGE_KEY = 'greychrist_tabs_v2';
const ACTIVE_TAB_KEY = 'greychrist_active_tab_v2';
const PERSISTENCE_ENABLED_KEY = 'greychrist_tab_persistence_enabled';

interface SerializedTab {
  id: string;
  type: Tab['type'];
  title: string;
  /** Missing on pre-Codex records; restored as `'claude'`. */
  agent?: AgentKind;
  sessionId?: string;
  claudeFileId?: string;
  initialProjectPath?: string;
  projectPath?: string;
  accountName?: string;
  accountColor?: string | null;
  accountIcon?: string | null;
  status: Tab['status'];
  hasUnsavedChanges: boolean;
  order: number;
  icon?: string;
  createdAt: string;
  updatedAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- utility-class pattern intentional; namespace-style functions less idiomatic in this codebase.
export class TabPersistenceService {
  static isEnabled(): boolean {
    const enabled = localStorage.getItem(PERSISTENCE_ENABLED_KEY);
    return enabled === null || enabled === 'true';
  }

  static setEnabled(enabled: boolean): void {
    localStorage.setItem(PERSISTENCE_ENABLED_KEY, String(enabled));
    if (!enabled) {
      this.clearTabs();
    }
  }
  static saveTabs(tabs: Tab[], activeTabId: string | null): void {
    if (!this.isEnabled()) return;
    
    try {
      // Persist running tabs too: the daemon's CLI outlives the renderer, so they are the ones worth restoring.

      const serializedTabs: SerializedTab[] = tabs.map(tab => ({
        id: tab.id,
        type: tab.type,
        title: tab.title,
        agent: tab.agent,
        sessionId: tab.sessionId,
        claudeFileId: tab.claudeFileId,
        initialProjectPath: tab.initialProjectPath,
        projectPath: tab.projectPath,
        accountName: tab.accountName,
        accountColor: tab.accountColor,
        accountIcon: tab.accountIcon,
        status: tab.status === 'running' ? 'idle' : tab.status,
        hasUnsavedChanges: false,
        order: tab.order,
        icon: tab.icon,
        createdAt: tab.createdAt instanceof Date ? tab.createdAt.toISOString() : tab.createdAt,
        updatedAt: tab.updatedAt instanceof Date ? tab.updatedAt.toISOString() : tab.updatedAt
      }));

      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializedTabs));
      
      // Guard only against an id naming no tab, never against a running one.
      if (activeTabId && tabs.some(tab => tab.id === activeTabId)) {
        localStorage.setItem(ACTIVE_TAB_KEY, activeTabId);
      }
    } catch (error) {
      console.error('Failed to save tabs:', error);
    }
  }

  static loadTabs(): { tabs: Tab[], activeTabId: string | null } {
    if (!this.isEnabled()) {
      return { tabs: [], activeTabId: null };
    }
    
    try {
      const savedTabsJson = localStorage.getItem(STORAGE_KEY);
      const savedActiveTabId = localStorage.getItem(ACTIVE_TAB_KEY);
      
      if (!savedTabsJson) {
        return { tabs: [], activeTabId: null };
      }

      const serializedTabs = JSON.parse(savedTabsJson) as SerializedTab[];
      
      const tabs: Tab[] = serializedTabs.map(serialized => ({
        ...serialized,
        agent: serialized.agent ?? 'claude',
        createdAt: new Date(serialized.createdAt),
        updatedAt: new Date(serialized.updatedAt),
        sessionData: undefined,
        status: serialized.status === 'running' ? 'idle' : serialized.status
      }));

      // The removed Usage tab collapses into one Cost Report tab, keeping the find-or-create singleton intact.
      let seenCostReport = false;
      const migrated = tabs
        .map((tab) => (
          (tab.type as string) === 'usage'
            ? { ...tab, type: 'cost-report' as const, title: 'Cost', icon: undefined }
            : tab
        ))
        .filter((tab) => {
          if (tab.type !== 'cost-report') return true;
          if (seenCostReport) return false;
          seenCostReport = true;
          return true;
        });

      const validTabs = migrated.filter(tab => {
        if (!tab.id || !tab.type || !tab.title) return false;
        
        switch (tab.type) {
          case 'chat':
            return true;
          case 'claude-file':
            return !!tab.claudeFileId;
          default:
            return true;
        }
      });

      const orderedTabs = validTabs
        .sort((a, b) => a.order - b.order)
        .map((tab, index) => ({ ...tab, order: index }));

      const activeTabId = savedActiveTabId && orderedTabs.some(tab => tab.id === savedActiveTabId)
        ? savedActiveTabId
        : orderedTabs.length > 0 ? orderedTabs[0].id : null;

      return { tabs: orderedTabs, activeTabId };
    } catch (error) {
      console.error('Failed to load tabs:', error);
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(ACTIVE_TAB_KEY);
      return { tabs: [], activeTabId: null };
    }
  }

  static clearTabs(): void {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ACTIVE_TAB_KEY);
  }

  static migrateFromOldFormat(): void {
    try {
      const oldKey = 'opcode_tabs';
      const oldData = localStorage.getItem(oldKey);
      if (oldData && !localStorage.getItem(STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, oldData);
        localStorage.removeItem(oldKey);
        console.log('Migrated tab data from v1 format');
      }

      const migrations: [string, string][] = [
        ['opcode_tabs_v2', STORAGE_KEY],
        ['opcode_active_tab_v2', ACTIVE_TAB_KEY],
        ['opcode_tab_persistence_enabled', PERSISTENCE_ENABLED_KEY],
      ];
      for (const [oldK, newK] of migrations) {
        const val = localStorage.getItem(oldK);
        if (val && !localStorage.getItem(newK)) {
          localStorage.setItem(newK, val);
          localStorage.removeItem(oldK);
          console.log(`Migrated storage key ${oldK} → ${newK}`);
        }
      }
    } catch (error) {
      console.error('Failed to migrate old tab data:', error);
    }
  }
}
