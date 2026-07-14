// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import type { Project } from '@/lib/api';
import { ProjectList } from '@/components/ProjectList';

// Render motion.tr/etc. as plain DOM elements so we can synchronously
// inspect row order without animation timing.
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_, key) => {
        const Tag = key as string;
        return ({ children, ...rest }: any) => {
          const { initial, animate, exit, transition, layout, whileTap, ...domProps } = rest;
          void initial; void animate; void exit; void transition; void layout; void whileTap;

          // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
          return require('react').createElement(Tag, domProps, children);
        };
      },
    },
  ),
  AnimatePresence: ({ children }: any) => children,
}));

// AccountBadge pulls from AccountsContext; stub the hook so the
// component doesn't need a real provider.
vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [],
    refresh: async () => {},
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => null,
  }),
}));

// AccountBadge also reads useTheme() now (theme-aware light/dark
// styling). Stub at the dark-default so the existing assertions keep
// matching the gray-theme color path.
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: async () => {} }),
}));

afterEach(() => { cleanup(); });

function makeProject(partial: Partial<Project> & Pick<Project, 'id' | 'path'>): Project {
  return {
    sessions: [],
    created_at: 0,
    pinned: false,
    ...partial,
  };
}

describe('ProjectList — pinned projects', () => {
  const rowNames = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('tbody tr')).map(
      (row) => row.querySelector('td')?.textContent ?? '',
    );

  // alpha is the OLDEST, so under the default lastActivity-desc sort it would
  // land last. Pinning it must drag it to the top.
  const projects = (): Project[] => [
    makeProject({ id: 'a', path: '/repos/alpha', most_recent_session: 1000, pinned: true }),
    makeProject({ id: 'b', path: '/repos/bravo', most_recent_session: 3000 }),
    makeProject({ id: 'c', path: '/repos/charlie', most_recent_session: 5000 }),
  ];

  it('floats pinned projects to the top under the default sort', () => {
    const { container } = render(
      <ProjectList projects={projects()} onProjectClick={() => {}} />,
    );
    expect(rowNames(container)).toEqual(['alpha', 'charlie', 'bravo']);
  });

  it('keeps pins on top when the sort direction flips', () => {
    // The trap: if the pin comparator multiplied by `dir` like every other
    // comparator does, flipping to ascending would sink pinned rows to the
    // BOTTOM — the exact opposite of what a pin is for.
    const { container } = render(
      <ProjectList projects={projects()} onProjectClick={() => {}} />,
    );
    fireEvent.click(screen.getByText('Last activity'));  // desc -> asc
    const names = rowNames(container);
    expect(names[0]).toBe('alpha');
    expect(names).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('keeps pins on top under every sort column, both directions', () => {
    const { container } = render(
      <ProjectList projects={projects()} onProjectClick={() => {}} />,
    );
    for (const header of ['Name', 'Path', 'Account', 'Sessions', 'Last activity']) {
      fireEvent.click(screen.getByText(header));
      expect(rowNames(container)[0]).toBe('alpha');
      fireEvent.click(screen.getByText(header));  // flip direction
      expect(rowNames(container)[0]).toBe('alpha');
    }
  });

  it('sorts within the pinned group by the active sort', () => {
    const twoPinned: Project[] = [
      makeProject({ id: 'a', path: '/repos/alpha', most_recent_session: 1000, pinned: true }),
      makeProject({ id: 'z', path: '/repos/zulu', most_recent_session: 9000, pinned: true }),
      makeProject({ id: 'b', path: '/repos/bravo', most_recent_session: 3000 }),
    ];
    const { container } = render(
      <ProjectList projects={twoPinned} onProjectClick={() => {}} />,
    );
    // Both pinned rows lead; zulu (9000) outranks alpha (1000) within them.
    expect(rowNames(container)).toEqual(['zulu', 'alpha', 'bravo']);
  });

  it('fires onTogglePin with the inverted state when the pin button is clicked', () => {
    const onTogglePin = vi.fn();
    render(
      <ProjectList
        projects={[makeProject({ id: 'b', path: '/repos/bravo' })]}
        onProjectClick={() => {}}
        onTogglePin={onTogglePin}
      />,
    );
    fireEvent.click(screen.getByLabelText('Pin this project'));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onTogglePin.mock.calls[0][0].path).toBe('/repos/bravo');
    expect(onTogglePin.mock.calls[0][1]).toBe(true);
  });

  it('offers to unpin an already-pinned project', () => {
    const onTogglePin = vi.fn();
    render(
      <ProjectList
        projects={[makeProject({ id: 'a', path: '/repos/alpha', pinned: true })]}
        onProjectClick={() => {}}
        onTogglePin={onTogglePin}
      />,
    );
    fireEvent.click(screen.getByLabelText('Unpin this project'));
    expect(onTogglePin.mock.calls[0][1]).toBe(false);
  });

  it('renders no pin button when onTogglePin is not supplied', () => {
    render(
      <ProjectList
        projects={[makeProject({ id: 'b', path: '/repos/bravo' })]}
        onProjectClick={() => {}}
      />,
    );
    expect(screen.queryByLabelText('Pin this project')).toBeNull();
  });
});

describe('ProjectList — "Last activity" sort', () => {
  it('default-sorts by Claude session activity (most_recent_session) DESC', () => {
    // Three projects with distinct most_recent_session values. The
    // default ProjectList sort is `lastActivity` / `desc`, so the row
    // order should be newest-session first regardless of input order.
    const projects: Project[] = [
      makeProject({ id: 'oldest', path: '/repos/alpha', most_recent_session: 1000 }),
      makeProject({ id: 'middle', path: '/repos/bravo', most_recent_session: 3000 }),
      makeProject({ id: 'newest', path: '/repos/charlie', most_recent_session: 5000 }),
    ];

    const { container } = render(
      <ProjectList projects={projects} onProjectClick={() => {}} />,
    );

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const names = rows.map((row) => row.querySelector('td')?.textContent ?? '');

    // charlie (5000) > bravo (3000) > alpha (1000)
    expect(names).toEqual(['charlie', 'bravo', 'alpha']);
  });
});

describe('ProjectList — click semantics', () => {
  function renderWithOne(handlers: {
    onProjectClick?: (p: Project) => void;
    onDeleteProject?: (p: Project) => void;
  }) {
    const projects: Project[] = [
      {
        id: '-repos-alpha',
        path: '/repos/alpha',
        sessions: ['s1', 's2', 's3'],
        created_at: 0,
        most_recent_session: 1000,
        account_id: 7,
        account_name: 'Personal',
        pinned: false,
      },
    ];
    return render(
      <ProjectList
        projects={projects}
        onProjectClick={handlers.onProjectClick ?? (() => {})}
        onDeleteProject={handlers.onDeleteProject}
      />,
    );
  }

  it('does NOT fire onProjectClick when the user clicks Path / Account / Sessions / Last activity cells', () => {
    const onProjectClick = vi.fn();
    const { container } = renderWithOne({ onProjectClick });

    // The five informational cells in order: name, path, account,
    // sessions, last activity, plus the new actions cell. We only want
    // to assert the four non-actionable middle cells stay inert; the
    // actions cell is exercised separately below.
    const cells = Array.from(
      container.querySelectorAll('tbody tr td'),
    );
    // Skip cell[0] (name, has a button) and cell[5] (actions). Click
    // cells 1..4.
    for (const cell of cells.slice(1, 5)) {
      fireEvent.click(cell);
    }
    expect(onProjectClick).not.toHaveBeenCalled();
  });

  it('fires onProjectClick when the user clicks the project name', () => {
    const onProjectClick = vi.fn();
    renderWithOne({ onProjectClick });

    // The name button's accessible name is its textContent ("alpha").
    // The Rocket button's accessible name comes from its aria-label
    // ("Launch this project") — different role-name match, so this
    // unambiguously hits the link.
    const nameButton = screen.getByRole('button', { name: 'alpha' });
    fireEvent.click(nameButton);
    expect(onProjectClick).toHaveBeenCalledTimes(1);
    expect(onProjectClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: '-repos-alpha' }),
    );
  });

  it('fires onProjectClick when the user clicks the Rocket icon', () => {
    const onProjectClick = vi.fn();
    renderWithOne({ onProjectClick });

    fireEvent.click(screen.getByRole('button', { name: 'Launch this project' }));
    expect(onProjectClick).toHaveBeenCalledTimes(1);
  });

  it('opens the confirm dialog (does not delete yet) when Trash is clicked', () => {
    const onDeleteProject = vi.fn();
    renderWithOne({ onDeleteProject });

    fireEvent.click(screen.getByRole('button', { name: 'Delete this project' }));
    expect(onDeleteProject).not.toHaveBeenCalled();
    // Dialog should be visible. Scope a query inside the dialog so we
    // don't match the path text that also appears in the table row.
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Delete this project?');
    expect(dialog.textContent).toContain('/repos/alpha');
    expect(dialog.textContent).toContain('Personal');
  });

  it('fires onDeleteProject only after the user confirms the dialog', () => {
    const onDeleteProject = vi.fn();
    renderWithOne({ onDeleteProject });

    fireEvent.click(screen.getByRole('button', { name: 'Delete this project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteProject).toHaveBeenCalledTimes(1);
    expect(onDeleteProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: '-repos-alpha' }),
    );
  });

  it('does not fire onDeleteProject when the user cancels the dialog', () => {
    const onDeleteProject = vi.fn();
    renderWithOne({ onDeleteProject });

    fireEvent.click(screen.getByRole('button', { name: 'Delete this project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDeleteProject).not.toHaveBeenCalled();
  });

  it('hides the trash icon entirely when no onDeleteProject prop is provided', () => {
    renderWithOne({}); // no onDeleteProject
    expect(
      screen.queryByRole('button', { name: 'Delete this project' }),
    ).toBeNull();
  });
});
