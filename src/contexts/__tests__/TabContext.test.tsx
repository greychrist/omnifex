// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { TabProvider, useTabContext } from '../TabContext';
import { useTabState } from '@/hooks/useTabState';

// Persistence + remote services: stub at the module boundary so tests
// don't touch localStorage and don't need IPC. Each test starts with an
// empty saved-tabs snapshot; the Provider's mount effect then constructs
// a default tab (`projects` when listAccounts returns ≥1, `settings`
// when it returns []).
vi.mock('@/services/tabPersistence', () => ({
  TabPersistenceService: {
    migrateFromOldFormat: vi.fn(),
    loadTabs: vi.fn(() => ({ tabs: [], activeTabId: null })),
    saveTabs: vi.fn(),
    clearTabs: vi.fn(),
  },
}));
vi.mock('@/services/sessionPersistence', () => ({
  SessionPersistenceService: {
    loadSession: vi.fn(() => null),
    createSessionFromRestoreData: vi.fn(),
  },
}));
vi.mock('@/services/sessionNameRegistry', () => ({
  sessionNameRegistry: { set: vi.fn(), snapshot: vi.fn(() => ({})) },
}));
vi.mock('@/lib/api', () => ({
  api: {
    listAccounts: vi.fn(async () => [{ id: 1, name: 'work', account_type: 'pro', config_dir: '/c' }]),
  },
}));

// window.electronAPI.onEvent — used for the notification-clicked listener.
beforeEach(() => {
  (globalThis as any).window.electronAPI = {
    onEvent: vi.fn(() => () => {}),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <TabProvider>{children}</TabProvider>;
}

async function flushInitialMount() {
  // The Provider's mount effect kicks off an async listAccounts() call.
  // Wait for the default tab to land before each test starts asserting.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('TabContext — initialization', () => {
  it('seeds a default projects tab when no saved tabs exist and accounts are present', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => {
      expect(result.current.tabs.length).toBe(1);
    });
    expect(result.current.tabs[0].type).toBe('projects');
    expect(result.current.activeTabId).toBe(result.current.tabs[0].id);
  });
});

describe('TabContext — addTab / removeTab', () => {
  it('adds a tab and makes it the active tab', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await flushInitialMount();
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });

    let newId = '';
    act(() => {
      newId = result.current.addTab({
        type: 'chat',
        title: 'New Chat',
        status: 'idle',
        hasUnsavedChanges: false,
      });
    });
    expect(result.current.tabs.length).toBe(2);
    expect(result.current.activeTabId).toBe(newId);
    expect(result.current.tabs[1].id).toBe(newId);
    expect(result.current.tabs[1].order).toBe(1);
  });

  it('throws when addTab would exceed the maximum (20)', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });

    // 19 more = 20 total.
    act(() => {
      for (let i = 0; i < 19; i++) {
        result.current.addTab({
          type: 'chat',
          title: `Chat ${i}`,
          status: 'idle',
          hasUnsavedChanges: false,
        });
      }
    });
    expect(result.current.tabs.length).toBe(20);

    expect(() => {
      act(() => {
        result.current.addTab({
          type: 'chat',
          title: 'overflow',
          status: 'idle',
          hasUnsavedChanges: false,
        });
      });
    }).toThrow(/Maximum number of tabs/);
  });

  it('removeTab reorders remaining tabs and selects a neighbor when removing active', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });

    let aId = '', bId = '', cId = '';
    act(() => {
      aId = result.current.addTab({ type: 'chat', title: 'A', status: 'idle', hasUnsavedChanges: false });
      bId = result.current.addTab({ type: 'chat', title: 'B', status: 'idle', hasUnsavedChanges: false });
      cId = result.current.addTab({ type: 'chat', title: 'C', status: 'idle', hasUnsavedChanges: false });
    });
    // active = cId. Close it; active should land on the new last-tab (b).
    act(() => { result.current.removeTab(cId); });
    expect(result.current.activeTabId).toBe(bId);
    expect(result.current.tabs.map((t) => t.id)).toEqual([
      result.current.tabs[0].id, aId, bId,
    ]);
    // Order reassigned 0..n-1.
    expect(result.current.tabs.map((t) => t.order)).toEqual([0, 1, 2]);
  });

  it('removeTab clears active when removing the last tab', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    const onlyId = result.current.tabs[0].id;

    act(() => { result.current.removeTab(onlyId); });
    expect(result.current.tabs.length).toBe(0);
    expect(result.current.activeTabId).toBeNull();
  });
});

describe('TabContext — updateTab / setActiveTab / reorderTabs', () => {
  it('updateTab merges partial updates and refreshes updatedAt', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    const id = result.current.tabs[0].id;
    const before = result.current.tabs[0].updatedAt.getTime();

    // Ensure updatedAt moves forward — wait at least 1 ms.
    await new Promise<void>((r) => setTimeout(r, 5));
    act(() => { result.current.updateTab(id, { title: 'Renamed', status: 'running' }); });
    const tab = result.current.tabs[0];
    expect(tab.title).toBe('Renamed');
    expect(tab.status).toBe('running');
    expect(tab.updatedAt.getTime()).toBeGreaterThan(before);
  });

  it('setActiveTab clears hasUnreadResult on the targeted tab', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });

    let unreadId = '';
    act(() => {
      unreadId = result.current.addTab({
        type: 'chat', title: 'Unread', status: 'idle', hasUnsavedChanges: false,
        hasUnreadResult: true,
      });
    });
    // Newly added tabs auto-activate — switch away then back to exercise the
    // unread-clearing branch explicitly.
    act(() => { result.current.setActiveTab(result.current.tabs[0].id); });
    expect(result.current.tabs.find((t) => t.id === unreadId)?.hasUnreadResult).toBe(true);

    act(() => { result.current.setActiveTab(unreadId); });
    expect(result.current.activeTabId).toBe(unreadId);
    expect(result.current.tabs.find((t) => t.id === unreadId)?.hasUnreadResult).toBe(false);
  });

  it('setActiveTab is a no-op for an unknown id', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    const active = result.current.activeTabId;
    act(() => { result.current.setActiveTab('does-not-exist'); });
    expect(result.current.activeTabId).toBe(active);
  });

  it('reorderTabs moves a tab and re-numbers order fields', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    act(() => {
      result.current.addTab({ type: 'chat', title: 'A', status: 'idle', hasUnsavedChanges: false });
      result.current.addTab({ type: 'chat', title: 'B', status: 'idle', hasUnsavedChanges: false });
    });
    const ids = result.current.tabs.map((t) => t.id);
    // Move position 0 (the default tab) to position 2.
    act(() => { result.current.reorderTabs(0, 2); });
    const after = result.current.tabs.map((t) => t.id);
    expect(after).toEqual([ids[1], ids[2], ids[0]]);
    expect(result.current.tabs.map((t) => t.order)).toEqual([0, 1, 2]);
  });
});

describe('TabContext — lookups', () => {
  it('getTabById returns the matching tab or undefined', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    const id = result.current.tabs[0].id;
    expect(result.current.getTabById(id)?.id).toBe(id);
    expect(result.current.getTabById('nope')).toBeUndefined();
  });

  it('getTabsByType filters to the requested type', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    act(() => {
      result.current.addTab({ type: 'chat', title: 'A', status: 'idle', hasUnsavedChanges: false });
      result.current.addTab({ type: 'chat', title: 'B', status: 'idle', hasUnsavedChanges: false });
    });
    expect(result.current.getTabsByType('chat')).toHaveLength(2);
  });

  it('closeAllTabs empties the list and clears persistence', async () => {
    const { result } = renderHook(() => useTabContext(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    act(() => { result.current.closeAllTabs(); });
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
  });
});

describe('useTabState — operation wrappers', () => {
  it('createChatTab adds a chat tab and returns its id', async () => {
    const { result } = renderHook(() => useTabState(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    let newId = '';
    act(() => { newId = result.current.createChatTab('proj-1', 'Hi', '/path'); });
    expect(result.current.tabs.find((t) => t.id === newId)?.type).toBe('chat');
  });

  it('switchToNextTab / PreviousTab wrap correctly around the list ends', async () => {
    const { result } = renderHook(() => useTabState(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    act(() => {
      result.current.createChatTab(undefined, 'A');
      result.current.createChatTab(undefined, 'B');
    });
    // Active = last (just-added 'B'); switch to next → wraps to first.
    const firstId = result.current.tabs[0].id;
    const lastId = result.current.tabs[result.current.tabs.length - 1].id;
    expect(result.current.activeTabId).toBe(lastId);

    act(() => { result.current.switchToNextTab(); });
    expect(result.current.activeTabId).toBe(firstId);
    act(() => { result.current.switchToPreviousTab(); });
    expect(result.current.activeTabId).toBe(lastId);
  });

  it('switchToTabByIndex switches to the tab at that position; out-of-range no-ops', async () => {
    const { result } = renderHook(() => useTabState(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    act(() => { result.current.createChatTab(undefined, 'A'); });
    act(() => { result.current.switchToTabByIndex(0); });
    expect(result.current.activeTabId).toBe(result.current.tabs[0].id);

    const before = result.current.activeTabId;
    act(() => { result.current.switchToTabByIndex(99); });
    expect(result.current.activeTabId).toBe(before);
  });

  it('canAddTab is true under the cap and false at the cap', async () => {
    const { result } = renderHook(() => useTabState(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    expect(result.current.canAddTab()).toBe(true);
    act(() => {
      for (let i = 0; i < 19; i++) {
        result.current.createChatTab(undefined, `T${i}`);
      }
    });
    expect(result.current.tabs.length).toBe(20);
    expect(result.current.canAddTab()).toBe(false);
  });

  it('findTabBySessionId / findTabByType return the matching tabs', async () => {
    const { result } = renderHook(() => useTabState(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    let chatId = '';
    act(() => { chatId = result.current.createChatTab('proj-x', 'Hi'); });
    // updateTab to attach a sessionId so findTabBySessionId can find it.
    act(() => { result.current.updateTab(chatId, { sessionId: 'sess-1' }); });
    expect(result.current.findTabBySessionId('sess-1')?.id).toBe(chatId);
    expect(result.current.findTabBySessionId('missing')).toBeUndefined();
    expect(result.current.findTabByType('chat')?.id).toBe(chatId);
  });

  it('markTabAsChanged / updateTabTitle / updateTabStatus mutate just the targeted fields', async () => {
    const { result } = renderHook(() => useTabState(), { wrapper });
    await waitFor(() => { expect(result.current.tabs.length).toBe(1); });
    const id = result.current.tabs[0].id;
    act(() => { result.current.markTabAsChanged(id, true); });
    expect(result.current.tabs[0].hasUnsavedChanges).toBe(true);
    act(() => { result.current.updateTabTitle(id, 'Renamed'); });
    expect(result.current.tabs[0].title).toBe('Renamed');
    act(() => { result.current.updateTabStatus(id, 'error'); });
    expect(result.current.tabs[0].status).toBe('error');
  });
});

describe('useTabContext — thrown without provider', () => {
  it('throws when used outside of a TabProvider', () => {
    // React logs the boundary error twice (dev double-render) before
    // re-throwing — suppress so test output stays clean.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useTabContext())).toThrow(
        /useTabContext must be used within a TabProvider/,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
