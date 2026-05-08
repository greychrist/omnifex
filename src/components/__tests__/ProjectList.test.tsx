// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
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
          const { initial, animate, exit, transition, layout, whileTap, ...domProps } = rest as any;
          void initial; void animate; void exit; void transition; void layout; void whileTap;
          // eslint-disable-next-line react/no-children-prop
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

afterEach(() => cleanup());

function makeProject(partial: Partial<Project> & Pick<Project, 'id' | 'path'>): Project {
  return {
    sessions: [],
    created_at: 0,
    ...partial,
  } as Project;
}

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
