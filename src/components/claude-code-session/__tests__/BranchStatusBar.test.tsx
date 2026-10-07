// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { BranchStatusBar } from '@/components/claude-code-session/BranchStatusBar';

afterEach(() => { cleanup(); });

const branch = { name: 'main', changed: 2, untracked: 0, path: '/repo', error: null };
const colorFor = () => ({ color: null, isTrunk: true });
const worktrees = [
  { path: '/repo-a', branch: 'feat/a', changed: 0, untracked: 0, error: null },
  { path: '/repo-b', branch: null, changed: 1, untracked: 0, error: null },
];

describe('BranchStatusBar', () => {
  it('wears the chat status bar\'s frame and type', () => {
    render(<BranchStatusBar branch={branch} worktrees={[]} colorFor={colorFor} />);
    const bar = screen.getByTestId('branch-status-bar');
    expect(bar.className).toContain('text-[10px]');
    expect(bar.className).toContain('font-mono');
    expect(bar.className).toContain('rounded-md');
  });

  // Label beside the badge, as `turn 12s` is — not stacked above it.
  it('puts the branch label on the badge\'s line', () => {
    render(<BranchStatusBar branch={branch} worktrees={[]} colorFor={colorFor} />);
    const label = screen.getByText('branch');
    expect(label.className).toContain('opacity-70');
    const row = label.parentElement!;
    expect(row.className).toMatch(/(^|\s)flex(\s|$)/);
    expect(row.className).not.toContain('flex-col');
    expect(row.contains(screen.getByRole('button', { name: /main/i }))).toBe(true);
  });

  it('puts the worktrees label on the same line as their badges', () => {
    render(<BranchStatusBar branch={branch} worktrees={worktrees} colorFor={colorFor} />);
    const label = screen.getByText('worktrees (2)');
    const row = label.parentElement!;
    expect(row.className).not.toContain('flex-col');
    expect(row.contains(screen.getByRole('button', { name: /feat\/a/i }))).toBe(true);
    expect(row.contains(screen.getByRole('button', { name: /\(detached\)/i }))).toBe(true);
  });

  it('sizes every badge to the bar', () => {
    render(<BranchStatusBar branch={branch} worktrees={worktrees} colorFor={colorFor} />);
    for (const b of screen.getAllByRole('button')) expect(b.className).toContain('text-[10px]');
  });

  it('leaves the worktrees out when there are none', () => {
    render(<BranchStatusBar branch={branch} worktrees={[]} colorFor={colorFor} />);
    expect(screen.queryByText(/worktrees/)).toBeNull();
    expect(screen.queryAllByTestId('status-divider')).toHaveLength(0);
  });

  it('shows the watch glyph after a divider', () => {
    render(
      <BranchStatusBar branch={branch} worktrees={[]} colorFor={colorFor} watch={<span data-testid="watch" />} />,
    );
    expect(screen.getByTestId('watch')).toBeTruthy();
    expect(screen.getAllByTestId('status-divider')).toHaveLength(1);
  });

  it('offers View changes on a worktree badge, for that worktree\'s path', () => {
    const onViewWorktreeChanges = vi.fn();
    render(
      <BranchStatusBar
        branch={branch}
        worktrees={worktrees}
        colorFor={colorFor}
        onViewWorktreeChanges={onViewWorktreeChanges}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /\(detached\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /view changes/i }));
    expect(onViewWorktreeChanges).toHaveBeenCalledWith('/repo-b');
  });
});
