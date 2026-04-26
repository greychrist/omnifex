/**
 * Tab Persistence Service
 * Handles saving and restoring tab state to/from localStorage
 */

import type { Tab } from '@/contexts/TabContext';

const STORAGE_KEY = 'greychrist_tabs_v2';
const ACTIVE_TAB_KEY = 'greychrist_active_tab_v2';
const PERSISTENCE_ENABLED_KEY = 'greychrist_tab_persistence_enabled';

interface SerializedTab {
  id: string;
  type: Tab['type'];
  title: string;
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
  // Note: We don't persist sessionData as it's a complex object
}

export class TabPersistenceService {
  /**
   * Check if tab persistence is enabled
   */
  static isEnabled(): boolean {
    const enabled = localStorage.getItem(PERSISTENCE_ENABLED_KEY);
    // Default to true if not set
    return enabled === null || enabled === 'true';
  }

  /**
   * Enable or disable tab persistence
   */
  static setEnabled(enabled: boolean): void {
    localStorage.setItem(PERSISTENCE_ENABLED_KEY, String(enabled));
    if (!enabled) {
      // Clear saved tabs when disabling persistence
      this.clearTabs();
    }
  }
  /**
   * Save tabs to localStorage
   */
  static saveTabs(tabs: Tab[], activeTabId: string | null): void {
    // Don't save if persistence is disabled
    if (!this.isEnabled()) return;
    
    try {
      // Filter out tabs that shouldn't be persisted
      const persistableTabs = tabs.filter(tab => {
        // Don't persist tabs with running status (they're likely stale)
        if (tab.status === 'running') return false;

        return true;
      });

      // Serialize tabs (excluding complex objects)
      const serializedTabs: SerializedTab[] = persistableTabs.map(tab => ({
        id: tab.id,
        type: tab.type,
        title: tab.title,
        sessionId: tab.sessionId,
        claudeFileId: tab.claudeFileId,
        initialProjectPath: tab.initialProjectPath,
        projectPath: tab.projectPath,
        accountName: tab.accountName,
        accountColor: tab.accountColor,
        accountIcon: tab.accountIcon,
        status: tab.status === 'running' ? 'idle' : tab.status, // Reset running status
        hasUnsavedChanges: false, // Reset unsaved changes
        order: tab.order,
        icon: tab.icon,
        createdAt: tab.createdAt instanceof Date ? tab.createdAt.toISOString() : tab.createdAt,
        updatedAt: tab.updatedAt instanceof Date ? tab.updatedAt.toISOString() : tab.updatedAt
      }));

      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializedTabs));
      
      // Save active tab ID
      if (activeTabId && persistableTabs.some(tab => tab.id === activeTabId)) {
        localStorage.setItem(ACTIVE_TAB_KEY, activeTabId);
      }
    } catch (error) {
      console.error('Failed to save tabs:', error);
    }
  }

  /**
   * Load tabs from localStorage
   */
  static loadTabs(): { tabs: Tab[], activeTabId: string | null } {
    // Don't load if persistence is disabled
    if (!this.isEnabled()) {
      return { tabs: [], activeTabId: null };
    }
    
    try {
      const savedTabsJson = localStorage.getItem(STORAGE_KEY);
      const savedActiveTabId = localStorage.getItem(ACTIVE_TAB_KEY);
      
      if (!savedTabsJson) {
        return { tabs: [], activeTabId: null };
      }

      const serializedTabs: SerializedTab[] = JSON.parse(savedTabsJson);
      
      // Deserialize tabs
      const tabs: Tab[] = serializedTabs.map(serialized => ({
        ...serialized,
        createdAt: new Date(serialized.createdAt),
        updatedAt: new Date(serialized.updatedAt),
        sessionData: undefined, // Will be loaded when tab is activated
        status: serialized.status === 'running' ? 'idle' : serialized.status // Ensure no running status
      }));

      // Validate and filter out any invalid tabs
      const validTabs = tabs.filter(tab => {
        // Basic validation
        if (!tab.id || !tab.type || !tab.title) return false;
        
        // Type-specific validation
        switch (tab.type) {
          case 'chat':
            // Chat tabs without sessionId or projectPath might be invalid
            // But we'll keep them as they might be new sessions
            return true;
          case 'claude-file':
            // Claude file tabs need a file ID
            return !!tab.claudeFileId;
          default:
            // Other tab types (projects, agents, usage, etc.) are always valid
            return true;
        }
      });

      // Ensure proper ordering
      const orderedTabs = validTabs
        .sort((a, b) => a.order - b.order)
        .map((tab, index) => ({ ...tab, order: index }));

      // Validate active tab ID
      const activeTabId = savedActiveTabId && orderedTabs.some(tab => tab.id === savedActiveTabId)
        ? savedActiveTabId
        : orderedTabs.length > 0 ? orderedTabs[0].id : null;

      return { tabs: orderedTabs, activeTabId };
    } catch (error) {
      console.error('Failed to load tabs:', error);
      // Clear corrupted data
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(ACTIVE_TAB_KEY);
      return { tabs: [], activeTabId: null };
    }
  }

  /**
   * Clear saved tabs
   */
  static clearTabs(): void {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ACTIVE_TAB_KEY);
  }

  /**
   * Migrate from old storage format if needed
   */
  static migrateFromOldFormat(): void {
    try {
      // Migrate from opcode_tabs (v1) format
      const oldKey = 'opcode_tabs';
      const oldData = localStorage.getItem(oldKey);
      if (oldData && !localStorage.getItem(STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, oldData);
        localStorage.removeItem(oldKey);
        console.log('Migrated tab data from v1 format');
      }

      // Migrate from opcode_* (v2) keys to greychrist_* keys
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
