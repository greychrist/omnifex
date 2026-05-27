// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { Folder, List, MessageSquare } from 'lucide-react';
import { getTabIcon, TabManager } from '../TabManager';
import type { Tab } from '@/contexts/TabContext';

// framer-motion's animation hooks are async by design and Reorder relies
// on layout effects that jsdom can't measure. Render every motion.* /
// Reorder.* element as plain DOM so we can fire events and assert
// synchronously. Same approach SessionList / ProjectList tests use.
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_, key) => {
        const Tag = key as string;
        return ({ children, ...rest }: any) => {
          const { initial, animate, exit, transition, layout, whileTap, whileDrag, layoutScroll, ...domProps } = rest;
          void initial; void animate; void exit; void transition; void layout; void whileTap; void whileDrag; void layoutScroll;
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
          return require('react').createElement(Tag, domProps, children);
        };
      },
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Reorder: {
    Group: ({ children, onReorder, values, axis, layoutScroll, ...rest }: any) => {
      void onReorder; void values; void axis; void layoutScroll;
      return <div {...rest}>{children}</div>;
    },
    Item: ({ children, value, id, dragListener, whileDrag, onDragStart, onDragEnd, ...rest }: any) => {
      void value; void dragListener; void whileDrag; void onDragStart; void onDragEnd;
      return <div data-tab-id={id} {...rest}>{children}</div>;
    },
  },
}));

// AccountBadge → AccountsContext → useTheme; stub both so the badge can
// render without a provider.
vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [],
    refresh: async () => {},
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => null,
  }),
}));
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: async () => {} }),
}));

// useTabState + useTabContext are the two main injection points. Stub
// them per-test via mockReturnValue so each scenario can pin its own
// tabs / active-tab / operation spies.
const useTabStateMock = vi.fn();
const useTabContextMock = vi.fn();
vi.mock('@/hooks/useTabState', () => ({
  useTabState: () => useTabStateMock(),
}));
vi.mock('@/contexts/TabContext', () => ({
  useTabContext: () => useTabContextMock(),
}));

afterEach(() => {
  cleanup();
  useTabStateMock.mockReset();
  useTabContextMock.mockReset();
});

function makeTab(partial: Partial<Tab> & Pick<Tab, 'id' | 'type' | 'title'>): Tab {
  return {
    agent: 'claude',
    status: 'idle',
    hasUnsavedChanges: false,
    order: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...partial,
  };
}

interface StateOverrides {
  tabs?: Tab[];
  activeTabId?: string | null;
  canAddTab?: boolean;
  createProjectsTab?: () => string | null;
  closeTab?: (id: string) => Promise<boolean>;
  switchToTab?: (id: string) => void;
}

function installState(overrides: StateOverrides = {}) {
  const tabs = overrides.tabs ?? [];
  const createProjectsTab = overrides.createProjectsTab ?? vi.fn(() => 'new-tab-id');
  const closeTab = overrides.closeTab ?? vi.fn(async () => true);
  const switchToTab = overrides.switchToTab ?? vi.fn();
  const canAddTab = vi.fn(() => overrides.canAddTab ?? true);
  const reorderTabs = vi.fn();

  useTabStateMock.mockReturnValue({
    tabs,
    activeTabId: overrides.activeTabId ?? (tabs[0]?.id ?? null),
    createChatTab: vi.fn(),
    createProjectsTab,
    createUsageTab: vi.fn(),
    createMCPTab: vi.fn(),
    createLimaTab: vi.fn(),
    createSettingsTab: vi.fn(),
    createClaudeMdTab: vi.fn(),
    createClaudeFileTab: vi.fn(),
    closeTab,
    closeCurrentTab: vi.fn(),
    switchToTab,
    switchToNextTab: vi.fn(),
    switchToPreviousTab: vi.fn(),
    switchToTabByIndex: vi.fn(),
    updateTab: vi.fn(),
    updateTabTitle: vi.fn(),
    updateTabStatus: vi.fn(),
    markTabAsChanged: vi.fn(),
    findTabBySessionId: vi.fn(),
    findTabByType: vi.fn(),
    canAddTab,
    activeTab: tabs.find((t) => t.id === overrides.activeTabId),
    tabCount: tabs.length,
    chatTabCount: tabs.filter((t) => t.type === 'chat').length,
  });

  useTabContextMock.mockReturnValue({
    reorderTabs,
  });

  return { createProjectsTab, closeTab, switchToTab, canAddTab, reorderTabs };
}

describe('getTabIcon', () => {
  it('returns the type default when no per-tab icon override is set', () => {
    expect(getTabIcon({ type: 'projects' })).toBe(Folder);
    expect(getTabIcon({ type: 'chat' })).toBe(MessageSquare);
  });

  it('honors a "list" icon override on a projects-type tab (sessions drill-down)', () => {
    expect(getTabIcon({ type: 'projects', icon: 'list' })).toBe(List);
  });

  it('falls through to the type default when icon override id is unknown (stale-state safe)', () => {
    expect(getTabIcon({ type: 'projects', icon: 'totally-not-a-real-icon-id' })).toBe(Folder);
    expect(getTabIcon({ type: 'chat', icon: 'whatever' })).toBe(MessageSquare);
  });

  it('treats undefined icon and missing icon identically', () => {
    expect(getTabIcon({ type: 'projects', icon: undefined })).toBe(Folder);
    expect(getTabIcon({ type: 'projects' })).toBe(Folder);
  });
});

describe('TabManager — rendering', () => {
  it('renders one TabItem per tab with its title', () => {
    installState({
      tabs: [
        makeTab({ id: 'a', type: 'chat', title: 'Chat A' }),
        makeTab({ id: 'b', type: 'projects', title: 'Projects' }),
      ],
      activeTabId: 'a',
    });

    render(<TabManager />);
    expect(screen.getByText('Chat A')).toBeDefined();
    expect(screen.getByText('Projects')).toBeDefined();
  });

  it('renders an account badge only when the tab has an accountName', () => {
    installState({
      tabs: [
        makeTab({ id: 'a', type: 'chat', title: 'With Acct', accountName: 'work' }),
        makeTab({ id: 'b', type: 'chat', title: 'No Acct' }),
      ],
      activeTabId: 'a',
    });

    const { container } = render(<TabManager />);
    // AccountBadge compact renders the name as a `title` attribute on its
    // icon-only span — only one tab carries one.
    expect(container.querySelectorAll('span[title="work"]').length).toBe(1);
  });

  it('shows the unsaved-changes dot only when no other status icon is present', () => {
    installState({
      tabs: [
        makeTab({ id: 'unsaved', type: 'chat', title: 'Dirty', hasUnsavedChanges: true }),
        // Tabs in `running` state should NOT show the dot — the spinner wins.
        makeTab({ id: 'running', type: 'chat', title: 'Spinning', hasUnsavedChanges: true, status: 'running' }),
      ],
      activeTabId: 'unsaved',
    });

    const { container } = render(<TabManager />);
    const dots = container.querySelectorAll('span[title="Unsaved changes"]');
    expect(dots.length).toBe(1);
  });

  it('renders the unread-result pulsing dot independently of other statuses', () => {
    installState({
      tabs: [
        makeTab({ id: 'a', type: 'chat', title: 'Done', hasUnreadResult: true, status: 'idle' }),
      ],
      activeTabId: null,
    });

    const { container } = render(<TabManager />);
    // The ping span is the outer animated layer.
    expect(container.querySelector('span.animate-ping')).not.toBeNull();
  });
});

describe('TabManager — interactions', () => {
  it('clicking a tab calls switchToTab with that tab id', () => {
    const { switchToTab } = installState({
      tabs: [
        makeTab({ id: 'a', type: 'chat', title: 'A' }),
        makeTab({ id: 'b', type: 'chat', title: 'B' }),
      ],
      activeTabId: 'a',
    });

    render(<TabManager />);
    fireEvent.click(screen.getByText('B'));
    expect(switchToTab).toHaveBeenCalledWith('b');
  });

  it('clicking the X button on a tab closes that tab (and stops propagation)', async () => {
    const { closeTab, switchToTab } = installState({
      tabs: [makeTab({ id: 'a', type: 'chat', title: 'A' })],
      activeTabId: 'a',
    });

    const { container } = render(<TabManager />);
    const closeBtn = container.querySelector('button[title="Close A"]');
    expect(closeBtn).not.toBeNull();
    await act(async () => { fireEvent.click(closeBtn!); });
    expect(closeTab).toHaveBeenCalledWith('a');
    // stopPropagation: clicking X must NOT also fire the row's onClick.
    expect(switchToTab).not.toHaveBeenCalled();
  });

  it('clicking the + button calls createProjectsTab when canAddTab is true', () => {
    const { createProjectsTab } = installState({
      tabs: [],
      canAddTab: true,
    });

    const { container } = render(<TabManager />);
    const newBtn = container.querySelector('button[title^="New project"]');
    expect(newBtn).not.toBeNull();
    fireEvent.click(newBtn!);
    expect(createProjectsTab).toHaveBeenCalledTimes(1);
  });

  it('does NOT call createProjectsTab when canAddTab is false (limit reached)', () => {
    const { createProjectsTab } = installState({
      tabs: [],
      canAddTab: false,
    });

    const { container } = render(<TabManager />);
    const newBtn = container.querySelector('button[title="Maximum tabs reached"]');
    expect(newBtn).not.toBeNull();
    fireEvent.click(newBtn!);
    expect(createProjectsTab).not.toHaveBeenCalled();
  });
});

describe('TabManager — keyboard-shortcut window events', () => {
  it('switch-to-tab event with a tabId switches to that tab', () => {
    const { switchToTab } = installState({
      tabs: [
        makeTab({ id: 'a', type: 'chat', title: 'A' }),
        makeTab({ id: 'b', type: 'chat', title: 'B' }),
      ],
      activeTabId: 'a',
    });

    render(<TabManager />);
    window.dispatchEvent(new CustomEvent('switch-to-tab', { detail: { tabId: 'b' } }));
    expect(switchToTab).toHaveBeenCalledWith('b');
  });

  it('create-chat-tab event creates a new projects tab', () => {
    const { createProjectsTab } = installState({ tabs: [] });
    render(<TabManager />);
    window.dispatchEvent(new CustomEvent('create-chat-tab'));
    expect(createProjectsTab).toHaveBeenCalledTimes(1);
  });

  it('close-current-tab event closes the active tab', async () => {
    const { closeTab } = installState({
      tabs: [makeTab({ id: 'active', type: 'chat', title: 'Active' })],
      activeTabId: 'active',
    });
    render(<TabManager />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('close-current-tab'));
      // The handler is async; flush the microtask queue.
      await Promise.resolve();
    });
    expect(closeTab).toHaveBeenCalledWith('active');
  });

  it('close-current-tab is a no-op when no tab is active', async () => {
    const { closeTab } = installState({ tabs: [], activeTabId: null });
    render(<TabManager />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('close-current-tab'));
      await Promise.resolve();
    });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('switch-to-next-tab wraps from the last tab to the first', () => {
    const { switchToTab } = installState({
      tabs: [
        makeTab({ id: 'a', type: 'chat', title: 'A' }),
        makeTab({ id: 'b', type: 'chat', title: 'B' }),
      ],
      activeTabId: 'b', // last → wraps to 'a'
    });
    render(<TabManager />);
    window.dispatchEvent(new CustomEvent('switch-to-next-tab'));
    expect(switchToTab).toHaveBeenCalledWith('a');
  });

  it('switch-to-previous-tab wraps from the first tab to the last', () => {
    const { switchToTab } = installState({
      tabs: [
        makeTab({ id: 'a', type: 'chat', title: 'A' }),
        makeTab({ id: 'b', type: 'chat', title: 'B' }),
      ],
      activeTabId: 'a', // first → wraps to 'b'
    });
    render(<TabManager />);
    window.dispatchEvent(new CustomEvent('switch-to-previous-tab'));
    expect(switchToTab).toHaveBeenCalledWith('b');
  });

  it('switch-to-tab-by-index switches to the tab at the given index', () => {
    const { switchToTab } = installState({
      tabs: [
        makeTab({ id: 'a', type: 'chat', title: 'A' }),
        makeTab({ id: 'b', type: 'chat', title: 'B' }),
        makeTab({ id: 'c', type: 'chat', title: 'C' }),
      ],
      activeTabId: 'a',
    });
    render(<TabManager />);
    window.dispatchEvent(new CustomEvent('switch-to-tab-by-index', { detail: { index: 2 } }));
    expect(switchToTab).toHaveBeenCalledWith('c');
  });

  it('switch-to-tab-by-index is a no-op for out-of-range indices', () => {
    const { switchToTab } = installState({
      tabs: [makeTab({ id: 'a', type: 'chat', title: 'A' })],
      activeTabId: 'a',
    });
    render(<TabManager />);
    window.dispatchEvent(new CustomEvent('switch-to-tab-by-index', { detail: { index: 99 } }));
    expect(switchToTab).not.toHaveBeenCalled();
  });

  it('removes all window listeners on unmount', () => {
    const { switchToTab } = installState({
      tabs: [makeTab({ id: 'a', type: 'chat', title: 'A' })],
      activeTabId: 'a',
    });
    const { unmount } = render(<TabManager />);
    unmount();
    window.dispatchEvent(new CustomEvent('switch-to-tab', { detail: { tabId: 'a' } }));
    expect(switchToTab).not.toHaveBeenCalled();
  });
});
