// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TabManager } from '../TabManager';
import type { Tab } from '@/contexts/TabContext';

/**
 * The motion/Reorder mock caches one component per tag.
 *
 * A Proxy that builds a fresh arrow function on every property access hands
 * React a NEW component type each render, so the whole subtree unmounts and
 * remounts continuously — any state inside it (a Radix dialog's open flag, a
 * tooltip's) is wiped before it can be observed. The cache is what makes the
 * element type stable.
 */
const tagCache = new Map<string, React.FC<any>>();
const tagComponent = (tag: string): React.FC<any> => {
  let C = tagCache.get(tag);
  if (!C) {
    C = ({ children, ...rest }: any) => {
      const {
        initial, animate, exit, transition, layout,
        whileTap, whileDrag, layoutScroll, ...domProps
      } = rest;
      void initial; void animate; void exit; void transition;
      void layout; void whileTap; void whileDrag; void layoutScroll;
      return React.createElement(tag, domProps, children);
    };
    tagCache.set(tag, C);
  }
  return C;
};

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: (_, key) => tagComponent(key as string) }),
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

const useTabStateMock = vi.fn();
const useTabContextMock = vi.fn();
vi.mock('@/hooks/useTabState', () => ({ useTabState: () => useTabStateMock() }));
vi.mock('@/contexts/TabContext', () => ({ useTabContext: () => useTabContextMock() }));

beforeAll(() => {
  // Radix positions dialog content through floating-ui, which measures with
  // ResizeObserver — absent in jsdom.
  class StubResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  useTabStateMock.mockReset();
  useTabContextMock.mockReset();
});

const ANCHOR = Date.parse('2026-09-15T10:00:00Z');

const tab = (over: Partial<Tab> = {}): Tab =>
  ({
    id: 't1',
    type: 'chat',
    title: 'My Session',
    status: 'idle',
    hasUnsavedChanges: false,
    order: 0,
    createdAt: new Date(ANCHOR),
    updatedAt: new Date(ANCHOR),
    ...over,
  }) as Tab;

function mount(t: Tab) {
  const closeTab = vi.fn(async () => true);
  useTabStateMock.mockReturnValue({
    tabs: [t],
    activeTabId: t.id,
    createChatTab: vi.fn(),
    createProjectsTab: vi.fn(),
    closeTab,
    switchToTab: vi.fn(),
    canAddTab: () => true,
    updateTab: vi.fn(),
  });
  useTabContextMock.mockReturnValue({
    tabs: [t],
    activeTabId: t.id,
    reorderTabs: vi.fn(),
    setActiveTab: vi.fn(),
    getTabById: () => t,
    updateTab: vi.fn(),
  });
  render(<TabManager />);
  return { closeTab };
}

const clickClose = () => {
  const btn = screen.getByRole('button', { name: /close tab/i });
  fireEvent.click(btn);
};

describe('closing a tab with work in it', () => {
  it('closes an idle tab immediately, with no dialog', () => {
    const { closeTab } = mount(tab());
    clickClose();
    expect(closeTab).toHaveBeenCalledWith('t1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does NOT close a working tab on the first click', async () => {
    const { closeTab } = mount(tab({ promptStatus: 'working' }));
    clickClose();
    await waitFor(() => { expect(screen.getByRole('dialog')).toBeTruthy(); });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('names the session in the prompt so the right tab is obvious', async () => {
    mount(tab({ promptStatus: 'working', title: 'Refactor auth' }));
    clickClose();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Refactor auth');
  });

  it('closes once confirmed, forcing past the unsaved-changes prompt', async () => {
    const { closeTab } = mount(tab({ promptStatus: 'working' }));
    clickClose();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /^stop and close$/i }));
    await waitFor(() => { expect(closeTab).toHaveBeenCalledWith('t1', true); });
  });

  it('keeps the session alive when cancelled', async () => {
    const { closeTab } = mount(tab({ promptStatus: 'working' }));
    clickClose();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('asks when subagents are still running', async () => {
    const { closeTab } = mount(tab({ activeAgents: 3 }));
    clickClose();
    await screen.findByRole('dialog');
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('asks when the session is blocked on a permission prompt', async () => {
    const { closeTab } = mount(tab({ waitingFor: 'permission' }));
    clickClose();
    await screen.findByRole('dialog');
    expect(closeTab).not.toHaveBeenCalled();
  });
});
