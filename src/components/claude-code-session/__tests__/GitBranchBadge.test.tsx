// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

import { GitBranchBadge } from '@/components/claude-code-session/GitBranchBadge';

afterEach(() => { cleanup(); });

const base = {
  name: 'main',
  changed: 2,
  untracked: 1,
  color: null,
  isTrunk: true,
  path: '/repo',
};

function openPopover() {
  // The badge is only a popover trigger when `path` is supplied.
  fireEvent.click(screen.getByRole('button', { name: /main/i }));
}

describe('GitBranchBadge — view changes', () => {
  it('offers to open the diff viewer when a handler is supplied', () => {
    render(<GitBranchBadge {...base} onViewChanges={vi.fn()} />);
    openPopover();
    expect(screen.getByRole('button', { name: /view changes/i })).toBeTruthy();
  });

  it('calls the handler when pressed', () => {
    const onViewChanges = vi.fn();
    render(<GitBranchBadge {...base} onViewChanges={onViewChanges} />);
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: /view changes/i }));
    expect(onViewChanges).toHaveBeenCalled();
  });

  it('offers nothing when no handler is supplied', () => {
    render(<GitBranchBadge {...base} />);
    openPopover();
    expect(screen.queryByRole('button', { name: /view changes/i })).toBeNull();
  });

  it('offers nothing when the working tree is clean', () => {
    // Nothing to diff — the control would open an empty viewer.
    render(<GitBranchBadge {...base} changed={0} untracked={0} onViewChanges={vi.fn()} />);
    openPopover();
    expect(screen.queryByRole('button', { name: /view changes/i })).toBeNull();
  });
});

describe('GitBranchBadge — bar size', () => {
  // On a status bar the badge keeps its chip, at the bar's 10px type.
  it('takes the status bar\'s text size, keeping its chip', () => {
    render(<GitBranchBadge {...base} size="bar" />);
    const chip = screen.getByRole('button', { name: /main/i });
    expect(chip.className).toContain('text-[10px]');
    expect(chip.className).not.toContain('text-[11px]');
    expect(chip.className).toContain('rounded');
    expect(chip.className).toContain('border');
  });

  it('keeps the header size by default', () => {
    render(<GitBranchBadge {...base} />);
    expect(screen.getByRole('button', { name: /main/i }).className).toContain('text-[11px]');
  });
});

describe('GitBranchBadge — repos and worktrees', () => {
  it('prefixes the branch with the repo name', () => {
    render(<GitBranchBadge {...base} repoName="api" />);
    expect(screen.getByRole('button').textContent).toMatch(/^api·main/);
  });

  it('lists worktrees in the popover, each with its own View changes', () => {
    const onViewWorktreeChanges = vi.fn();
    render(
      <GitBranchBadge
        {...base}
        changed={0}
        untracked={0}
        worktrees={[
          { path: '/wt/a', branch: 'feat/a', changed: 1, untracked: 0, error: null },
          { path: '/wt/b', branch: null, changed: 0, untracked: 0, error: null },
        ]}
        onViewWorktreeChanges={onViewWorktreeChanges}
      />,
    );
    openPopover();
    expect(screen.getByText('Worktrees (2)')).toBeTruthy();
    expect(screen.getByText('feat/a')).toBeTruthy();
    expect(screen.getByText('(detached)')).toBeTruthy();
    // Only the dirty worktree offers a diff; the clean repo itself offers none.
    const buttons = screen.getAllByRole('button', { name: /view changes/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onViewWorktreeChanges).toHaveBeenCalledWith('/wt/a', 'feat/a');
  });
});

