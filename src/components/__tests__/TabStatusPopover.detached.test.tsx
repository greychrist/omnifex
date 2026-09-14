// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { TabStatusPopover } from '../TabStatusPopover';
import { TooltipProvider } from '@/components/ui/tooltip-modern';

const setActiveTab = vi.fn();
const addTab = vi.fn();
let mockTabs: Array<Record<string, unknown>> = [];

vi.mock('@/contexts/TabContext', () => ({
  useTabContext: () => ({ tabs: mockTabs, setActiveTab, addTab }),
}));

const listTabStatuses = vi.fn(async () => [] as unknown[]);
vi.mock('@/lib/api', () => ({
  api: {
    listTabStatuses: () => listTabStatuses(),
    onTabStatusesChanged: () => () => {},
  },
}));

function setDaemon(sessions: unknown[], projects: unknown[]) {
  (window as unknown as { __omnifexRemote?: unknown }).__omnifexRemote = {
    mode: 'electron',
    client: {
      request: (method: string) =>
        Promise.resolve(method === 'session.list' ? sessions : projects),
    },
  };
}

const WIN_SESSION = {
  sessionId: '25d0800c-c395-4477-b78f-ca3f54945135',
  projectId: 'proj-win',
  title: 'WIN',
  agent: 'claude',
  sessionStatus: 'started',
  inFlight: true,
  pendingPermissions: 0,
  updatedAt: '2026-09-14T15:00:00Z',
};
const WIN_PROJECT = { projectId: 'proj-win', path: '/Users/g/Repos/WIN', title: 'WIN' };

beforeEach(() => {
  mockTabs = [];
  setActiveTab.mockClear();
  addTab.mockClear();
  listTabStatuses.mockClear();
});

afterEach(() => {
  // Auto-cleanup is not enabled in this config, so renders would otherwise
  // pile up in document.body and every query would match N times.
  cleanup();
  delete (window as unknown as { __omnifexRemote?: unknown }).__omnifexRemote;
});

async function openPopover() {
  render(
    <TooltipProvider>
      <TabStatusPopover />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByTestId('sessions-trigger'));
}

describe('TabStatusPopover — detached sessions', () => {
  it('lists a live daemon session that has no tab here', async () => {
    setDaemon([WIN_SESSION], [WIN_PROJECT]);
    await openPopover();
    await waitFor(() => { expect(screen.getByText('WIN')).toBeTruthy(); });
    expect(screen.getByText(WIN_SESSION.sessionId)).toBeTruthy();
  });

  it('opens a tab bound to that session when clicked', async () => {
    // The whole point: the tab is gone, the session is not, and clicking
    // reconnects rather than doing nothing.
    setDaemon([WIN_SESSION], [WIN_PROJECT]);
    await openPopover();
    await waitFor(() => { expect(screen.getByText('WIN')).toBeTruthy(); });

    fireEvent.click(screen.getByText('WIN'));

    expect(addTab).toHaveBeenCalledTimes(1);
    expect(addTab.mock.calls[0][0]).toMatchObject({
      type: 'chat',
      sessionId: WIN_SESSION.sessionId,
      initialProjectPath: '/Users/g/Repos/WIN',
      agent: 'claude',
    });
  });

  it('focuses the existing tab instead of opening a second one', async () => {
    mockTabs = [{ id: 'tab-1', type: 'chat', order: 0, sessionId: WIN_SESSION.sessionId }];
    setDaemon([WIN_SESSION], [WIN_PROJECT]);
    await openPopover();
    // Bound to a tab here, so it is not a detached row at all.
    await waitFor(() => { expect(listTabStatuses).toHaveBeenCalled(); });
    expect(screen.queryByText('No path')).toBeNull();
    expect(addTab).not.toHaveBeenCalled();
  });

  it('will not open a session whose project path is unknown', async () => {
    setDaemon([{ ...WIN_SESSION, projectId: 'gone' }], []);
    await openPopover();
    await waitFor(() => { expect(screen.getByText('No path')).toBeTruthy(); });

    fireEvent.click(screen.getByText('WIN'));
    expect(addTab).not.toHaveBeenCalled();
  });

  it('ignores sessions the daemon reports as stopped', async () => {
    setDaemon([{ ...WIN_SESSION, sessionStatus: 'stopped' }], [WIN_PROJECT]);
    await openPopover();
    await waitFor(() => { expect(listTabStatuses).toHaveBeenCalled(); });
    expect(screen.queryByText('WIN')).toBeNull();
  });

  it('renders tabs-only when there is no daemon at all', async () => {
    await openPopover();
    await waitFor(() => { expect(listTabStatuses).toHaveBeenCalled(); });
    expect(screen.getByText('No chat tabs open.')).toBeTruthy();
    expect(addTab).not.toHaveBeenCalled();
  });

  it('survives a daemon that rejects the request', async () => {
    (window as unknown as { __omnifexRemote?: unknown }).__omnifexRemote = {
      mode: 'electron',
      client: { request: () => Promise.reject(new Error('ECONNREFUSED')) },
    };
    await openPopover();
    await waitFor(() => { expect(screen.getByText('No chat tabs open.')).toBeTruthy(); });
  });
});
