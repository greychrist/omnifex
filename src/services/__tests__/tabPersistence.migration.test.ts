// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TabPersistenceService } from '../tabPersistence';

/**
 * The Usage dashboard was removed once it turned out to be unreachable — its
 * only entry point was a window event nothing dispatched — and the Cost Report
 * supersedes it. A tab persisted by an older build must not restore into a
 * type that no longer renders, which shows as a blank tab with no error.
 */
describe('tabPersistence — retired usage tab', () => {
  beforeEach(() => { window.localStorage.clear(); });

  const write = (tabs: unknown[], activeTabId: string | null = null) => {
    window.localStorage.setItem('greychrist_tabs_v2', JSON.stringify(tabs));
    if (activeTabId) window.localStorage.setItem('greychrist_active_tab_v2', activeTabId);
  };

  const tab = (over: Record<string, unknown>) => ({
    id: 't1', type: 'usage', title: 'Usage', order: 0, status: 'idle',
    hasUnsavedChanges: false, agent: 'claude',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...over,
  });

  it('migrates a persisted usage tab to the cost report', () => {
    write([tab({})]);
    const restored = TabPersistenceService.loadTabs();
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0].type).toBe('cost-report');
    expect(restored.tabs[0].title).toBe('Cost');
  });

  it('keeps the tab active if it was the active one', () => {
    write([tab({})], 't1');
    expect(TabPersistenceService.loadTabs().activeTabId).toBe('t1');
  });

  // Two of them would restore as two Cost tabs, breaking the singleton the
  // opener relies on to find-or-create.
  it('collapses a usage tab alongside an existing cost-report tab', () => {
    write([
      tab({ id: 't1' }),
      tab({ id: 't2', type: 'cost-report', title: 'Cost', order: 1 }),
    ]);
    const restored = TabPersistenceService.loadTabs();
    expect(restored.tabs.filter((t) => t.type === 'cost-report')).toHaveLength(1);
  });

  it('leaves every other tab type alone', () => {
    write([
      tab({ id: 'a', type: 'projects', title: 'Projects', order: 0 }),
      tab({ id: 'b', type: 'brain', title: 'Brain', order: 1 }),
    ]);
    const restored = TabPersistenceService.loadTabs();
    expect(restored.tabs.map((t) => t.type)).toEqual(['projects', 'brain']);
  });
});
