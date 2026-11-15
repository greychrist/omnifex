// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { BranchStatusBar } from '@/components/claude-code-session/BranchStatusBar';
import type { RepoSnapshot, SessionGitSnapshot } from '@/lib/api';

afterEach(() => { cleanup(); });

function repo(name: string, path: string, branch: string, extra: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    name,
    root: { path, branch, changed: 0, untracked: 0, error: null },
    worktrees: [],
    ...extra,
  };
}

function bar(snapshot: SessionGitSnapshot, props: Partial<React.ComponentProps<typeof BranchStatusBar>> = {}) {
  const onOpenRepos = vi.fn();
  const onViewChanges = vi.fn();
  render(
    <BranchStatusBar
      snapshot={snapshot}
      pins={{}}
      onOpenRepos={onOpenRepos}
      onViewChanges={onViewChanges}
      {...props}
    />,
  );
  return { onOpenRepos, onViewChanges };
}

describe('BranchStatusBar', () => {
  it('wears the chat status bar\'s frame and type', () => {
    bar({ repos: [repo('', '/p', 'main')], foundCount: 0 });
    const el = screen.getByTestId('branch-status-bar');
    expect(el.className).toContain('text-[10px]');
    expect(el.className).toContain('font-mono');
    expect(el.className).toContain('rounded-md');
  });

  it('labels a lone project repo "branch" and shows the branch alone', () => {
    bar({ repos: [repo('', '/p', 'main')], foundCount: 0 });
    const label = screen.getByText('branch');
    expect(label.className).toContain('opacity-70');
    expect(label.parentElement!.contains(screen.getByRole('button', { name: /^main/ }))).toBe(true);
  });

  it('labels several repos "repos (N)" and prefixes each chip with its repo name', () => {
    bar({ repos: [repo('api', '/p/api', 'main'), repo('web', '/p/web', 'feat/login')], foundCount: 0 });
    expect(screen.getByText('repos (2)')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^api·main/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^web·feat\/login/ })).toBeTruthy();
  });

  it('names the project repo by its folder when it sits among sub-repos', () => {
    bar({ repos: [repo('', '/x/proj', 'main'), repo('sub', '/x/proj/sub', 'dev')], foundCount: 0 });
    expect(screen.getByRole('button', { name: /^proj·main/ })).toBeTruthy();
  });

  it('shows "+N found" after the chips and opens the repos dialog', () => {
    const { onOpenRepos } = bar({ repos: [repo('', '/p', 'main')], foundCount: 2 });
    fireEvent.click(screen.getByRole('button', { name: /\+2 found/ }));
    expect(onOpenRepos).toHaveBeenCalled();
  });

  it('shows "N repos found" when nothing is watched yet', () => {
    const { onOpenRepos } = bar({ repos: [], foundCount: 2 });
    fireEvent.click(screen.getByRole('button', { name: /2 repos found/ }));
    expect(onOpenRepos).toHaveBeenCalled();
  });

  it('shows "no repos" when nothing was found', () => {
    bar({ repos: [], foundCount: 0 });
    expect(screen.getByRole('button', { name: /no repos/ })).toBeTruthy();
  });

  it('offers a bare repos button when everything found is watched', () => {
    const { onOpenRepos } = bar({ repos: [repo('', '/p', 'main')], foundCount: 0 });
    fireEvent.click(screen.getByRole('button', { name: /manage repos/i }));
    expect(onOpenRepos).toHaveBeenCalled();
  });

  it('colours each repo from its own pins', () => {
    bar(
      { repos: [repo('a', '/p/a', 'feat'), repo('b', '/p/b', 'feat')], foundCount: 0 },
      { pins: { '/p/a': { feat: '#ff0000' } } },
    );
    const a = screen.getByRole('button', { name: /^a·feat/ });
    const b = screen.getByRole('button', { name: /^b·feat/ });
    expect(a.getAttribute('style')).toContain('rgb(255, 0, 0)');
    expect(b.getAttribute('style') ?? '').not.toContain('rgb(255, 0, 0)');
  });

  it('opens a worktree\'s diff from its repo chip with the worktree\'s label', () => {
    const { onViewChanges } = bar({
      repos: [repo('', '/p', 'main', {
        worktrees: [{ path: '/wt', branch: 'feat/x', changed: 1, untracked: 0, error: null }],
      })],
      foundCount: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: /^main/ }));
    fireEvent.click(screen.getByRole('button', { name: /view changes/i }));
    expect(onViewChanges).toHaveBeenCalledWith('/wt', 'feat/x');
  });

  it('sizes every chip to the bar', () => {
    bar({ repos: [repo('a', '/p/a', 'main'), repo('b', '/p/b', 'dev')], foundCount: 1 });
    for (const b of screen.getAllByRole('button')) expect(b.className).toContain('text-[10px]');
  });

  it('shows the watch glyph after a divider', () => {
    bar({ repos: [repo('', '/p', 'main')], foundCount: 0 }, { watch: <span data-testid="watch" /> });
    expect(screen.getByTestId('watch')).toBeTruthy();
    expect(screen.getAllByTestId('status-divider').length).toBeGreaterThan(0);
  });
});
