// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import type { Tab } from '@/contexts/TabContext';

const project = { id: '-repo-alpha', path: '/repo/alpha', sessions: ['s1'], created_at: 0, most_recent_session: 0 };

// The tab list is the test's own state; updateTab mutates it and re-renders.
let tabs: Tab[] = [];
let activeTabId = 't1';
let rerender: () => void = () => {};
const updateTab = vi.fn((id: string, patch: Partial<Tab>) => {
  tabs = tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
  rerender();
});
vi.mock('@/hooks/useTabState', () => ({
  useTabState: () => ({
    tabs, activeTabId, updateTab,
    createChatTab: vi.fn(), findTabBySessionId: vi.fn(), closeTab: vi.fn(),
  }),
}));

let resolveSessions: (s: unknown[]) => void = () => {};
vi.mock('@/lib/api', () => ({
  api: {
    listProjects: vi.fn(async () => [project]),
    getProjectSessions: vi.fn(() => new Promise((r) => { resolveSessions = r; })),
    resolveAccountForProject: vi.fn(async () => ({ claude: null, codex: null })),
    stopSession: vi.fn(async () => {}),
  },
}));

vi.mock('@/components/ProjectList', () => ({
  ProjectList: ({ projects, onProjectClick }: { projects: typeof project[]; onProjectClick: (p: typeof project) => void }) => (
    <div data-testid="project-list">
      {projects.map((p) => <button key={p.id} onClick={() => { onProjectClick(p); }}>{p.path}</button>)}
    </div>
  ),
}));
vi.mock('@/components/SessionList', () => ({
  SessionList: ({ sessions }: { sessions: { id: string }[] }) => (
    <ul data-testid="session-list">{sessions.map((s) => <li key={s.id}>{s.id}</li>)}</ul>
  ),
}));
vi.mock('@/components/NewSessionForm', () => ({ NewSessionForm: () => null }));
vi.mock('@/components/ProjectReposDialog', () => ({ ProjectReposCard: () => null }));
vi.mock('@/components/AgentSession', () => ({ AgentSession: () => <div data-testid="chat" /> }));
vi.mock('@/hooks/useCodexAuthStatus', () => ({ useCodexAuthStatus: () => null }));

import { TabContent } from '../TabContent';
import { api } from '@/lib/api';
import { __resetProjectsCacheForTests } from '@/lib/projectsCache';

function mount() {
  // No TooltipProvider: the app mounts none above TabContent either.
  const view = render(<TabContent />);
  rerender = () => { view.rerender(<TabContent />); };
  return view;
}
const projectsTab = (extra: Partial<Tab> = {}): Tab => ({ id: 't1', type: 'projects', title: 'Projects', agent: 'claude', status: 'idle', hasUnsavedChanges: false, order: 0, createdAt: new Date(), updatedAt: new Date(), ...extra });

beforeEach(() => { __resetProjectsCacheForTests(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('TabContent — projects tab', () => {
  // The sessions page used to wait on getProjectSessions before it showed.
  it('opens a project\'s sessions page at once and fills the list when it arrives', async () => {
    tabs = [projectsTab()];
    mount();
    fireEvent.click(await screen.findByText('/repo/alpha'));
    expect(await screen.findByRole('button', { name: 'Back to Projects' })).toBeTruthy();
    expect(screen.getByTestId('sessions-loading')).toBeTruthy();
    await act(async () => { resolveSessions([{ id: 'sess-1' }]); });
    expect(screen.queryByTestId('sessions-loading')).toBeNull();
    expect(screen.getByText('sess-1')).toBeTruthy();
  });

  it('backing out of a session lands on that project\'s sessions page, not the projects list', async () => {
    tabs = [{ ...projectsTab(), type: 'chat', title: 'alpha', initialProjectPath: '/repo/alpha' }];
    mount();
    await act(async () => { window.dispatchEvent(new CustomEvent('back-to-project', { detail: { projectPath: '/repo/alpha' } })); });
    expect(tabs[0].type).toBe('projects');
    expect(await screen.findByRole('button', { name: 'Back to Projects' })).toBeTruthy();
    expect(api.getProjectSessions).toHaveBeenCalledWith('-repo-alpha', '/repo/alpha');
    expect(tabs[0].title).toBe('alpha: Sessions');
    // The hand-off is consumed, so the next visit is the plain list.
    expect(tabs[0].returnToProjectPath).toBeUndefined();
  });

  // A list fetched once is shown straight away on the next visit while it
  // refreshes, instead of a skeleton.
  it('shows the last list it fetched while a new projects tab refreshes', async () => {
    tabs = [projectsTab()];
    const first = mount();
    await screen.findByText('/repo/alpha');
    first.unmount();
    vi.mocked(api.listProjects).mockImplementationOnce(() => new Promise(() => {}));
    tabs = [projectsTab({ id: 't2' })];
    activeTabId = 't2';
    mount();
    expect(screen.getByText('/repo/alpha')).toBeTruthy();
    activeTabId = 't1';
  });
});
