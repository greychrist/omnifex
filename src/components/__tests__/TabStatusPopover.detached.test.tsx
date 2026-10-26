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
    mode: 'desktop',
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

  it('hands the tab the session to resume, not just its id', async () => {
    // AgentSession resumes only when it is given `sessionData`; a tab with a
    // bare `sessionId` rendered the New Session panel instead.
    setDaemon([WIN_SESSION], [WIN_PROJECT]);
    await openPopover();
    await waitFor(() => { expect(screen.getByText('WIN')).toBeTruthy(); });

    fireEvent.click(screen.getByText('WIN'));

    expect(addTab.mock.calls[0][0].sessionData).toMatchObject({
      id: WIN_SESSION.sessionId,
      project_id: '-Users-g-Repos-WIN',
      project_path: '/Users/g/Repos/WIN',
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
      mode: 'desktop',
      client: { request: () => Promise.reject(new Error('ECONNREFUSED')) },
    };
    await openPopover();
    await waitFor(() => { expect(screen.getByText('No chat tabs open.')).toBeTruthy(); });
  });
});

describe('TabStatusPopover — where each session is open', () => {
  it('labels a session by where it is open, and Detached when nowhere', async () => {
    setDaemon(
      [
        { ...WIN_SESSION, sessionId: 'in-app', title: 'AppOne', inFlight: false, openIn: ['desktop'] },
        { ...WIN_SESSION, sessionId: 'in-browser', title: 'WebOne', inFlight: false, openIn: ['web'] },
        { ...WIN_SESSION, sessionId: 'orphan', title: 'Nobody', inFlight: false, openIn: [] },
      ],
      [WIN_PROJECT],
    );
    await openPopover();
    await waitFor(() => { expect(screen.getByText('Nobody')).toBeTruthy(); });

    const card = (title: string) => screen.getByText(title).closest('button')!;
    expect(card('AppOne').textContent).toContain('Open in App');
    expect(card('WebOne').textContent).toContain('Open in Browser');
    expect(card('Nobody').textContent).toContain('Detached');
    expect(card('AppOne').textContent).not.toContain('Detached');
  });

  it('labels this window\'s own tab Open Here', async () => {
    mockTabs = [{ id: 'tab-1', type: 'chat', order: 0, sessionId: 'mine' }];
    listTabStatuses.mockResolvedValueOnce([{
      tabId: 'tab-1', title: 'MyTab', sessionId: 'mine', status: 'idle', promptStatus: 'ready',
      waitingFor: null, branch: null, filesChanged: 0, filesUntracked: 0, contextUsage: null,
      mainTurnInFlight: false, activeAgents: 0, tasks: { total: 0, completed: 0, inFlight: false },
    }]);
    setDaemon([], []);
    await openPopover();
    await waitFor(() => { expect(screen.getByText('MyTab')).toBeTruthy(); });
    expect(screen.getByText('MyTab').closest('button')!.textContent).toContain('Open Here');
  });
});

describe('TabStatusPopover — closing a detached session', () => {
  function daemonWithKill(sessions: unknown[]) {
    const requests: Array<{ method: string; params: unknown }> = [];
    (window as unknown as { __omnifexRemote?: unknown }).__omnifexRemote = {
      mode: 'web',
      client: {
        request: (method: string, params: unknown) => {
          requests.push({ method, params });
          if (method === 'session.list') return Promise.resolve(sessions);
          if (method === 'project.list') return Promise.resolve([WIN_PROJECT]);
          return Promise.resolve(undefined);
        },
      },
    };
    return requests;
  }
  const kills = (requests: Array<{ method: string; params: unknown }>) =>
    requests.filter((r) => r.method === 'session.kill').map((r) => r.params);

  it('offers Close only on a session no client has open, and closing stops it', async () => {
    const requests = daemonWithKill([
      { ...WIN_SESSION, sessionId: 'orphan', title: 'Nobody', inFlight: false, openIn: [] },
      { ...WIN_SESSION, sessionId: 'in-app', title: 'AppOne', inFlight: false, openIn: ['desktop'] },
    ]);
    await openPopover();
    await waitFor(() => { expect(screen.getByText('Nobody')).toBeTruthy(); });

    const closes = screen.getAllByRole('button', { name: /^Close session/ });
    expect(closes).toHaveLength(1);
    fireEvent.click(closes[0]);
    await waitFor(() => { expect(kills(requests)).toEqual([{ sessionId: 'orphan' }]); });
    // Closing is not opening.
    expect(addTab).not.toHaveBeenCalled();
  });

  it('asks again before stopping a session that is still working', async () => {
    const requests = daemonWithKill([
      { ...WIN_SESSION, sessionId: 'busy', title: 'Busy', inFlight: true, openIn: [] },
    ]);
    await openPopover();
    await waitFor(() => { expect(screen.getByText('Busy')).toBeTruthy(); });

    fireEvent.click(screen.getByRole('button', { name: /^Close session/ }));
    expect(kills(requests)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /^Stop working session/ }));
    await waitFor(() => { expect(kills(requests)).toEqual([{ sessionId: 'busy' }]); });
  });
});
