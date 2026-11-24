// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import type { Project } from '@/lib/api';
import { ProjectList } from '@/components/ProjectList';

// Plain DOM so row order can be read without animation timing.
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_, key) => {
        const Tag = key as string;
        return ({ children, ...rest }: any) => {
          const { initial: _initial, animate: _animate, exit: _exit, transition: _transition, layout: _layout, whileTap: _whileTap, ...domProps } = rest;

          // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
          return require('react').createElement(Tag, domProps, children);
        };
      },
    },
  ),
  AnimatePresence: ({ children }: any) => children,
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

afterEach(() => { cleanup(); });

function makeProject(partial: Partial<Project> & Pick<Project, 'id' | 'path'>): Project {
  return {
    sessions: [],
    created_at: 0,
    pinned: false,
    ...partial,
  };
}

// The name cell stacks the name over its path.
const rowNames = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('tbody tr')).map(
    (row) => row.querySelector('[data-project-name]')?.textContent ?? '',
  );

describe('ProjectList — pinned projects', () => {

  // alpha is the OLDEST, so under the default sort it would land last.
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
    // The trap: a pin comparator multiplied by `dir` like the others would flip.
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
    for (const header of ['Name', 'Account', 'Last activity']) {
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
    const projects: Project[] = [
      makeProject({ id: 'oldest', path: '/repos/alpha', most_recent_session: 1000 }),
      makeProject({ id: 'middle', path: '/repos/bravo', most_recent_session: 3000 }),
      makeProject({ id: 'newest', path: '/repos/charlie', most_recent_session: 5000 }),
    ];

    const { container } = render(
      <ProjectList projects={projects} onProjectClick={() => {}} />,
    );

    // charlie (5000) > bravo (3000) > alpha (1000)
    expect(rowNames(container)).toEqual(['charlie', 'bravo', 'alpha']);
  });
});

describe('ProjectList — click semantics', () => {
  function renderWithOne(handlers: {
    onProjectClick?: (p: Project) => void;
    onQuickLaunch?: (p: Project) => void;
    onTogglePin?: (p: Project, pinned: boolean) => void;
    onOpenSettings?: (p: Project) => void;
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
        onQuickLaunch={handlers.onQuickLaunch}
        onTogglePin={handlers.onTogglePin}
        onOpenSettings={handlers.onOpenSettings}
      />,
    );
  }

  it('does NOT fire onProjectClick when the user clicks Account / Last activity cells', () => {
    const onProjectClick = vi.fn();
    const { container } = renderWithOne({ onProjectClick });

    // Cells in order: pin, actions, name (+path), account, last activity, settings.
    const cells = Array.from(
      container.querySelectorAll('tbody tr td'),
    );
    expect(cells).toHaveLength(6);
    for (const cell of cells.slice(3, 5)) {
      fireEvent.click(cell);
    }
    expect(onProjectClick).not.toHaveBeenCalled();
  });

  it('orders the row: pin, actions, name, then the settings gear last', () => {
    const { container } = renderWithOne({
      onQuickLaunch: vi.fn(),
      onTogglePin: vi.fn(),
      onOpenSettings: vi.fn(),
    });

    const cells = Array.from(container.querySelectorAll('tbody tr td'));
    expect(cells[0].querySelector('[aria-label="Pin this project"]')).not.toBeNull();
    expect(cells[0].querySelector('[data-project-name]')).toBeNull();
    expect(cells[1].querySelector('[aria-label="Launch"]')).not.toBeNull();
    expect(cells[1].querySelector('[aria-label="Sessions (3)"]')).not.toBeNull();
    expect(cells[2].querySelector('[data-project-name]')?.textContent).toBe('alpha');
    expect(cells[5].querySelector('[aria-label="Project settings"]')).not.toBeNull();
  });

  it('gives every row control the same outline button chrome', () => {
    renderWithOne({
      onQuickLaunch: vi.fn(),
      onTogglePin: vi.fn(),
      onOpenSettings: vi.fn(),
    });

    for (const name of ['Pin this project', 'Sessions (3)', 'Launch', 'Project settings']) {
      const btn = screen.getByRole('button', { name });
      expect(btn.className).toContain('border-input');
      expect(btn.className).toContain('h-8');
    }
  });

  it('orders the actions Sessions first, then Launch', () => {
    const { container } = renderWithOne({ onQuickLaunch: vi.fn() });

    const sessions = screen.getByRole('button', { name: 'Sessions (3)' });
    const launch = screen.getByRole('button', { name: 'Launch' });
    // DOCUMENT_POSITION_FOLLOWING === 4.
    expect(
      sessions.compareDocumentPosition(launch) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const cells = Array.from(container.querySelectorAll('tbody tr td'));
    expect(cells[1].contains(sessions)).toBe(true);
    expect(cells[1].contains(launch)).toBe(true);
  });

  it('renders Launch and Sessions as icon-only buttons', () => {
    const { container } = renderWithOne({ onQuickLaunch: vi.fn() });

    const launch = screen.getByRole('button', { name: 'Launch' });
    const sessions = screen.getByRole('button', { name: 'Sessions (3)' });
    expect(launch.textContent).not.toContain('Launch');
    expect(sessions.textContent).not.toContain('Sessions');
    expect(sessions.textContent).toContain('3');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('labels every column, including the three control columns', () => {
    const { container } = renderWithOne({});

    const headers = Array.from(container.querySelectorAll('thead th'));
    expect(headers.map((h) => h.textContent?.trim())).toEqual([
      'Pin',
      'Actions',
      'Name',
      'Account',
      'Last activity',
      'Settings',
    ]);
  });

  it('left-justifies the Actions header', () => {
    const { container } = renderWithOne({});

    const actionsHeader = Array.from(container.querySelectorAll('thead th')).find(
      (th) => th.textContent?.trim() === 'Actions',
    )!;
    expect(actionsHeader.className).not.toContain('text-right');
  });

  it('drops the redundant aria-labels now that the control headers have text', () => {
    const { container } = renderWithOne({});

    // An aria-label on a <th> overrides its visible text for screen readers.
    for (const th of Array.from(container.querySelectorAll('thead th'))) {
      expect(th.getAttribute('aria-label')).toBeNull();
    }
  });

  it('fires onProjectClick when the user clicks the project name', () => {
    const onProjectClick = vi.fn();
    renderWithOne({ onProjectClick });

    // The name button's accessible name is its textContent ("alpha").
    // The action buttons' accessible names come from their aria-labels,
    // so this unambiguously hits the name link.
    const nameButton = screen.getByRole('button', { name: 'alpha' });
    fireEvent.click(nameButton);
    expect(onProjectClick).toHaveBeenCalledTimes(1);
    expect(onProjectClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: '-repos-alpha' }),
    );
  });

  it('fires onProjectClick when the user clicks the Sessions button', () => {
    const onProjectClick = vi.fn();
    renderWithOne({ onProjectClick });

    fireEvent.click(screen.getByRole('button', { name: 'Sessions (3)' }));
    expect(onProjectClick).toHaveBeenCalledTimes(1);
    expect(onProjectClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: '-repos-alpha' }),
    );
  });

  it('fires onQuickLaunch (not onProjectClick) when the user clicks the Launch button', () => {
    const onProjectClick = vi.fn();
    const onQuickLaunch = vi.fn();
    renderWithOne({ onProjectClick, onQuickLaunch });

    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onQuickLaunch).toHaveBeenCalledTimes(1);
    expect(onQuickLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ id: '-repos-alpha' }),
    );
    expect(onProjectClick).not.toHaveBeenCalled();
  });

  it('renders Launch and Sessions as buttons in the actions cell', () => {
    const { container } = renderWithOne({ onQuickLaunch: vi.fn() });
    const cells = Array.from(container.querySelectorAll('tbody tr td'));
    const actions = cells[1];

    const launch = screen.getByRole('button', { name: 'Launch' });
    const sessions = screen.getByRole('button', { name: 'Sessions (3)' });
    expect(actions.contains(launch)).toBe(true);
    expect(actions.contains(sessions)).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Launch' })).toHaveLength(1);
  });

  it('hides the Launch button when no onQuickLaunch prop is provided', () => {
    renderWithOne({}); // no onQuickLaunch
    expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sessions (3)' })).toBeTruthy();
  });

  it('fires onOpenSettings when the settings action is clicked', () => {
    const onOpenSettings = vi.fn();
    const onProjectClick = vi.fn();
    render(
      <ProjectList
        projects={[makeProject({ id: 'b', path: '/repos/bravo' })]}
        onProjectClick={onProjectClick}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings.mock.calls[0][0].path).toBe('/repos/bravo');
    expect(onProjectClick).not.toHaveBeenCalled();
  });

  it('hides the settings action when no onOpenSettings prop is provided', () => {
    renderWithOne({});
    expect(screen.queryByRole('button', { name: 'Project settings' })).toBeNull();
  });

  it('renders no Delete button', () => {
    renderWithOne({ onQuickLaunch: vi.fn() });
    expect(
      screen.queryByRole('button', { name: 'Delete this project' }),
    ).toBeNull();
  });
});

describe('ProjectList — header actions', () => {
  const one = (): Project[] => [makeProject({ id: 'a', path: '/repos/alpha' })];

  it('fires onNewProject when New Project is clicked', () => {
    const onNewProject = vi.fn();
    const onOpenProject = vi.fn();
    render(
      <ProjectList
        projects={one()}
        onProjectClick={() => {}}
        onOpenProject={onOpenProject}
        onNewProject={onNewProject}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /New Project/ }));
    expect(onNewProject).toHaveBeenCalledTimes(1);
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it('puts New Project immediately to the left of Open Project', () => {
    render(
      <ProjectList projects={one()} onProjectClick={() => {}} onNewProject={() => {}} />,
    );
    const newBtn = screen.getByRole('button', { name: /New Project/ });
    const openBtn = screen.getByRole('button', { name: /Open Project/ });
    expect(
      newBtn.compareDocumentPosition(openBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('hides New Project when no onNewProject prop is provided', () => {
    render(<ProjectList projects={one()} onProjectClick={() => {}} />);
    expect(screen.queryByRole('button', { name: /New Project/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Open Project/ })).toBeTruthy();
  });
});

describe('ProjectList — name column layout', () => {
  const one = (): Project[] => [
    makeProject({ id: 'a', path: '/Users/greg/Repos/personal/alpha', sessions: ['s1'] }),
  ];

  it('drops the standalone Path and Sessions columns', () => {
    render(<ProjectList projects={one()} onProjectClick={() => {}} />);
    expect(screen.queryByText('Path')).toBeNull();
    expect(screen.queryByText('Sessions')).toBeNull();
  });

  it('renders the home-relative path under the name, inside the name cell', () => {
    const { container } = render(
      <ProjectList projects={one()} onProjectClick={() => {}} />,
    );
    const nameCell = container.querySelector('tbody tr td:has([data-project-name])')!;
    const path = nameCell.querySelector('[data-project-path]');
    expect(path?.textContent).toBe('~/Repos/personal/alpha');
  });

  it('renders long paths in full — they wrap instead of being ellipsized', () => {
    const long =
      '/private/var/folders/06/s9_hqx1n0dz4k2v9m7t3p5rc0000gn/T/omnifex-summary-scratch';
    const { container } = render(
      <ProjectList
        projects={[makeProject({ id: 'x', path: long })]}
        onProjectClick={() => {}}
      />,
    );
    const path = container.querySelector('[data-project-path]');
    expect(path?.textContent).toBe(long);
    expect(path?.textContent).not.toContain('...');
    // `truncate` would defeat the wrapping.
    expect(path?.className).not.toContain('truncate');
  });

  it('gives the name column the table\'s slack so the path has room to wrap', () => {
    const { container } = render(
      <ProjectList projects={one()} onProjectClick={() => {}} />,
    );
    const nameHeader = Array.from(container.querySelectorAll('thead th')).find(
      (th) => th.textContent?.trim().startsWith('Name'),
    )!;
    expect(nameHeader.className).toContain('w-full');
  });

  it('puts the pin control in front of the project name', () => {
    const { container } = render(
      <ProjectList projects={one()} onProjectClick={() => {}} onTogglePin={() => {}} />,
    );
    const nameCell = container.querySelector('tbody tr td:has([data-project-name])')!;
    const pin = screen.getByLabelText('Pin this project');
    expect(nameCell.contains(pin)).toBe(false);
    expect(container.querySelectorAll('tbody tr td')[0].contains(pin)).toBe(true);
    // DOCUMENT_POSITION_FOLLOWING === 4.
    const name = container.querySelector('[data-project-name]')!;
    expect(pin.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the session count inside the Sessions button', () => {
    render(
      <ProjectList
        projects={[makeProject({ id: 'b', path: '/repos/bravo', sessions: ['1', '2', '3', '4'] })]}
        onProjectClick={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Sessions (4)' })).toBeTruthy();
  });
});

describe('ProjectList — pinned/unpinned boundary', () => {
  const mixed = (): Project[] => [
    makeProject({ id: 'a', path: '/repos/alpha', most_recent_session: 1000, pinned: true }),
    makeProject({ id: 'b', path: '/repos/bravo', most_recent_session: 3000 }),
    makeProject({ id: 'c', path: '/repos/charlie', most_recent_session: 5000 }),
  ];

  it('marks the last pinned row as the group boundary', () => {
    const { container } = render(
      <ProjectList projects={mixed()} onProjectClick={() => {}} />,
    );
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    // alpha is the only pinned row, so it closes the pinned group.
    expect(rows[0].getAttribute('data-pin-boundary')).toBe('true');
    expect(rows[1].getAttribute('data-pin-boundary')).not.toBe('true');
    expect(rows[2].getAttribute('data-pin-boundary')).not.toBe('true');
  });

  it('marks only the LAST pinned row when several are pinned', () => {
    const twoPinned: Project[] = [
      makeProject({ id: 'a', path: '/repos/alpha', most_recent_session: 1000, pinned: true }),
      makeProject({ id: 'z', path: '/repos/zulu', most_recent_session: 9000, pinned: true }),
      makeProject({ id: 'b', path: '/repos/bravo', most_recent_session: 3000 }),
    ];
    const { container } = render(
      <ProjectList projects={twoPinned} onProjectClick={() => {}} />,
    );
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    // zulu, alpha, bravo — the boundary sits under alpha, not zulu.
    expect(rows[0].getAttribute('data-pin-boundary')).not.toBe('true');
    expect(rows[1].getAttribute('data-pin-boundary')).toBe('true');
  });

  it('draws no boundary when nothing is pinned', () => {
    const { container } = render(
      <ProjectList
        projects={[makeProject({ id: 'b', path: '/repos/bravo' })]}
        onProjectClick={() => {}}
      />,
    );
    expect(container.querySelector('[data-pin-boundary="true"]')).toBeNull();
  });

  it('draws no boundary when every project is pinned', () => {
    const { container } = render(
      <ProjectList
        projects={[
          makeProject({ id: 'a', path: '/repos/alpha', pinned: true }),
          makeProject({ id: 'z', path: '/repos/zulu', pinned: true }),
        ]}
        onProjectClick={() => {}}
      />,
    );
    expect(container.querySelector('[data-pin-boundary="true"]')).toBeNull();
  });
});

describe('ProjectList — first load', () => {
  it('shows a skeleton, not the empty state, while loading', () => {
    render(<ProjectList projects={[]} onProjectClick={() => {}} loading />);
    expect(screen.getByTestId('project-list-skeleton')).toBeTruthy();
    expect(screen.queryByText('No recent projects')).toBeNull();
  });

  it('shows the empty state once loaded with nothing', () => {
    render(<ProjectList projects={[]} onProjectClick={() => {}} loading={false} />);
    expect(screen.getByText('No recent projects')).toBeTruthy();
    expect(screen.queryByTestId('project-list-skeleton')).toBeNull();
  });

  it('keeps showing projects it already has during a refetch', () => {
    const { container } = render(
      <ProjectList
        projects={[makeProject({ id: 'a', path: '/repos/alpha' })]}
        onProjectClick={() => {}}
        loading
      />,
    );
    expect(rowNames(container)).toEqual(['alpha']);
    expect(screen.queryByTestId('project-list-skeleton')).toBeNull();
  });
});
