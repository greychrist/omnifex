// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TabPersistenceService } from '../tabPersistence';
import type { Tab } from '@/contexts/TabContext';

const STORAGE_KEY = 'greychrist_tabs_v2';
const ACTIVE_TAB_KEY = 'greychrist_active_tab_v2';
const PERSISTENCE_ENABLED_KEY = 'greychrist_tab_persistence_enabled';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makeTab(partial: Partial<Tab> & Pick<Tab, 'id' | 'type' | 'title'>): Tab {
  return {
    status: 'idle',
    hasUnsavedChanges: false,
    order: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...partial,
  };
}

describe('TabPersistenceService — isEnabled / setEnabled', () => {
  it('defaults to enabled when the key is missing', () => {
    expect(TabPersistenceService.isEnabled()).toBe(true);
  });

  it('honors a stored "false" string as disabled', () => {
    localStorage.setItem(PERSISTENCE_ENABLED_KEY, 'false');
    expect(TabPersistenceService.isEnabled()).toBe(false);
  });

  it('setEnabled(false) writes the flag AND clears existing saved tabs', () => {
    localStorage.setItem(STORAGE_KEY, '[{"any":"data"}]');
    localStorage.setItem(ACTIVE_TAB_KEY, 'tab-1');
    TabPersistenceService.setEnabled(false);
    expect(localStorage.getItem(PERSISTENCE_ENABLED_KEY)).toBe('false');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ACTIVE_TAB_KEY)).toBeNull();
  });

  it('setEnabled(true) leaves existing tabs alone', () => {
    localStorage.setItem(STORAGE_KEY, '[]');
    TabPersistenceService.setEnabled(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('[]');
    expect(localStorage.getItem(PERSISTENCE_ENABLED_KEY)).toBe('true');
  });
});

describe('TabPersistenceService — saveTabs / loadTabs roundtrip', () => {
  it('writes serialized tabs + active id and reads them back', () => {
    const tabs = [
      makeTab({ id: 't1', type: 'chat', title: 'Chat 1', sessionId: 's1', projectPath: '/p' }),
      makeTab({ id: 't2', type: 'projects', title: 'Projects', order: 1 }),
    ];
    TabPersistenceService.saveTabs(tabs, 't2');

    const { tabs: loaded, activeTabId } = TabPersistenceService.loadTabs();
    expect(loaded.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(activeTabId).toBe('t2');
    expect(loaded[0].createdAt).toBeInstanceOf(Date);
    expect(loaded[0].sessionId).toBe('s1');
  });

  it('drops tabs with status=running on save (likely stale)', () => {
    const tabs = [
      makeTab({ id: 't1', type: 'chat', title: 'Alive' }),
      makeTab({ id: 'running', type: 'chat', title: 'Was Running', status: 'running' }),
    ];
    TabPersistenceService.saveTabs(tabs, 't1');
    const { tabs: loaded } = TabPersistenceService.loadTabs();
    expect(loaded.map((t) => t.id)).toEqual(['t1']);
  });

  it('resets hasUnsavedChanges to false on round-trip', () => {
    const tabs = [makeTab({ id: 't1', type: 'chat', title: 'Dirty', hasUnsavedChanges: true })];
    TabPersistenceService.saveTabs(tabs, 't1');
    const { tabs: loaded } = TabPersistenceService.loadTabs();
    expect(loaded[0].hasUnsavedChanges).toBe(false);
  });

  it('does NOT persist activeTabId when the active tab itself was filtered out', () => {
    const tabs = [
      makeTab({ id: 't1', type: 'chat', title: 'Alive' }),
      makeTab({ id: 'running', type: 'chat', title: 'Running', status: 'running' }),
    ];
    TabPersistenceService.saveTabs(tabs, 'running');
    expect(localStorage.getItem(ACTIVE_TAB_KEY)).toBeNull();
  });

  it('does nothing when persistence is disabled', () => {
    localStorage.setItem(PERSISTENCE_ENABLED_KEY, 'false');
    const tabs = [makeTab({ id: 't1', type: 'chat', title: 'A' })];
    TabPersistenceService.saveTabs(tabs, 't1');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(TabPersistenceService.loadTabs()).toEqual({ tabs: [], activeTabId: null });
  });

  it('returns empty when no saved data exists', () => {
    expect(TabPersistenceService.loadTabs()).toEqual({ tabs: [], activeTabId: null });
  });
});

describe('TabPersistenceService — loadTabs validation', () => {
  it('drops claude-file tabs missing a claudeFileId', () => {
    const corruptData = JSON.stringify([
      {
        id: 't1', type: 'claude-file', title: 'No File ID',
        status: 'idle', hasUnsavedChanges: false, order: 0,
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      },
      {
        id: 't2', type: 'claude-file', title: 'Has File ID', claudeFileId: 'file-1',
        status: 'idle', hasUnsavedChanges: false, order: 1,
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      },
    ]);
    localStorage.setItem(STORAGE_KEY, corruptData);
    const { tabs } = TabPersistenceService.loadTabs();
    expect(tabs.map((t) => t.id)).toEqual(['t2']);
  });

  it('reorders tabs by `order` and renumbers them 0..n-1', () => {
    const out = JSON.stringify([
      { id: 'b', type: 'projects', title: 'B', status: 'idle', hasUnsavedChanges: false, order: 5, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
      { id: 'a', type: 'projects', title: 'A', status: 'idle', hasUnsavedChanges: false, order: 2, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
    ]);
    localStorage.setItem(STORAGE_KEY, out);
    const { tabs } = TabPersistenceService.loadTabs();
    expect(tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(tabs.map((t) => t.order)).toEqual([0, 1]);
  });

  it('falls back to first tab when stored activeTabId is missing/unknown', () => {
    const out = JSON.stringify([
      { id: 'a', type: 'projects', title: 'A', status: 'idle', hasUnsavedChanges: false, order: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
    ]);
    localStorage.setItem(STORAGE_KEY, out);
    localStorage.setItem(ACTIVE_TAB_KEY, 'does-not-exist');
    const { activeTabId } = TabPersistenceService.loadTabs();
    expect(activeTabId).toBe('a');
  });

  it('clears the corrupted keys and returns empty when JSON parse fails', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(STORAGE_KEY, 'not-json');
    const result = TabPersistenceService.loadTabs();
    expect(result).toEqual({ tabs: [], activeTabId: null });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ACTIVE_TAB_KEY)).toBeNull();
    errorSpy.mockRestore();
  });
});

describe('TabPersistenceService — clearTabs', () => {
  it('removes both storage keys', () => {
    localStorage.setItem(STORAGE_KEY, '[]');
    localStorage.setItem(ACTIVE_TAB_KEY, 't');
    TabPersistenceService.clearTabs();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ACTIVE_TAB_KEY)).toBeNull();
  });
});

describe('TabPersistenceService — migrateFromOldFormat', () => {
  it('moves opcode_tabs (v1) data into the v2 key', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    localStorage.setItem('opcode_tabs', '[]');
    TabPersistenceService.migrateFromOldFormat();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('[]');
    expect(localStorage.getItem('opcode_tabs')).toBeNull();
    logSpy.mockRestore();
  });

  it('moves opcode_*_v2 keys to greychrist_*_v2 keys', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    localStorage.setItem('opcode_tabs_v2', '[]');
    localStorage.setItem('opcode_active_tab_v2', 't1');
    localStorage.setItem('opcode_tab_persistence_enabled', 'true');
    TabPersistenceService.migrateFromOldFormat();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('[]');
    expect(localStorage.getItem(ACTIVE_TAB_KEY)).toBe('t1');
    expect(localStorage.getItem(PERSISTENCE_ENABLED_KEY)).toBe('true');
    expect(localStorage.getItem('opcode_tabs_v2')).toBeNull();
    logSpy.mockRestore();
  });

  it('does not overwrite an existing new-key value', () => {
    localStorage.setItem('opcode_tabs', '[OLD]');
    localStorage.setItem(STORAGE_KEY, '[NEW]');
    TabPersistenceService.migrateFromOldFormat();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('[NEW]');
    // Stale opcode_tabs key sticks around when migration doesn't run; the
    // migration only deletes the source when it actually wrote to the
    // destination. That's the intended idempotent behavior.
    expect(localStorage.getItem('opcode_tabs')).toBe('[OLD]');
  });
});
