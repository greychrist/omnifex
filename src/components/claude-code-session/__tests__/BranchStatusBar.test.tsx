// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { BranchStatusBar } from '@/components/claude-code-session/BranchStatusBar';
import type { PathSnapshot, RepoSnapshot, SessionGitSnapshot } from '@/lib/api';

afterEach(() => { cleanup(); });

function wt(path: string, branch: string, extra: Partial<PathSnapshot> = {}): PathSnapshot {
  return { path, branch, changed: 0, untracked: 0, error: null, ...extra };
}

function repo(name: string, path: string, branch: string, extra: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return { name, root: wt(path, branch), worktrees: [], ...extra };
}

function bar(snapshot: SessionGitSnapshot, props: Partial<React.ComponentProps<typeof BranchStatusBar>> = {}) {
  const onOpenRepos = vi.fn();
  const onViewChanges = vi.fn();
  render(
    <BranchStatusBar snapshot={snapshot} pins={{}} onOpenRepos={onOpenRepos} onViewChanges={onViewChanges} {...props} />,
  );
  return { onOpenRepos, onViewChanges };
}

const encompass: SessionGitSnapshot = {
  repos: [
    repo('encompass-platform-backend', '/e/encompass-platform-backend', 'dev', {
      root: wt('/e/encompass-platform-backend', 'dev', { changed: 3 }),
      worktrees: [wt('/e/worktrees/be-1', 'test/wt-be-1'), wt('/e/worktrees/be-2', 'test/wt-be-2', { changed: 1, untracked: 2 })],
    }),
    repo('encompass-platform-frontend', '/e/encompass-platform-frontend', 'dev', {
      worktrees: [wt('/e/worktrees/fe-1', 'test/wt-fe-1')],
    }),
  ],
  foundCount: 0,
};

describe('BranchStatusBar', () => {
  it('wears the chat status bar\'s frame and type', () => {
    bar(encompass);
    const el = screen.getByTestId('branch-status-bar');
    expect(el.className).toContain('text-[10px]');
    expect(el.className).toContain('font-mono');
    expect(el.className).toContain('rounded-md');
  });

  it('draws each repo as one capsule: its name, its main checkout, then each worktree', () => {
    bar(encompass);
    const be = screen.getByRole('group', { name: 'encompass-platform-backend' });
    const segments = within(be).getAllByRole('button').map((b) => b.textContent);
    expect(segments[0]).toBe('backend');
    expect(segments[1]).toMatch(/^dev3$/);
    expect(segments[2]).toBe('test/wt-be-1');
    expect(segments[3]).toMatch(/^test\/wt-be-212$/);
    expect(within(screen.getByRole('group', { name: 'encompass-platform-frontend' })).getAllByRole('button')).toHaveLength(3);
  });

  it('spaces repo capsules further apart than the segments inside them', () => {
    bar(encompass);
    const row = screen.getByRole('group', { name: 'encompass-platform-backend' }).parentElement!;
    expect(row.className).toContain('gap-x-2.5');
  });

  it('drops the prefix the repo names share, keeping the full name in the tooltip', () => {
    bar(encompass);
    const name = screen.getByRole('button', { name: 'frontend' });
    expect(name.getAttribute('title')).toContain('encompass-platform-frontend');
  });

  it('keeps a lone repo\'s full name', () => {
    bar({ repos: [repo('encompass-platform-backend', '/e/b', 'dev')], foundCount: 0 });
    expect(screen.getByRole('button', { name: 'encompass-platform-backend' })).toBeTruthy();
  });

  it('names the project folder\'s own repo by the folder', () => {
    bar({ repos: [repo('', '/x/proj', 'main')], foundCount: 0 });
    expect(screen.getByRole('group', { name: 'proj' })).toBeTruthy();
  });

  it('draws the main checkout heavier than its worktrees', () => {
    bar(encompass);
    const be = within(screen.getByRole('group', { name: 'encompass-platform-backend' })).getAllByRole('button');
    expect(be[1].className).toContain('font-semibold');
    expect(be[2].className).not.toContain('font-semibold');
  });

  it('opens a worktree\'s diff from its own segment', () => {
    const { onViewChanges } = bar(encompass);
    fireEvent.click(screen.getByRole('button', { name: /^test\/wt-be-2/ }));
    fireEvent.click(screen.getByRole('button', { name: /view changes/i }));
    expect(onViewChanges).toHaveBeenCalledWith('/e/worktrees/be-2', 'test/wt-be-2');
  });

  it('opens the repos dialog from a repo\'s name', () => {
    const { onOpenRepos } = bar(encompass);
    fireEvent.click(screen.getByRole('button', { name: 'backend' }));
    expect(onOpenRepos).toHaveBeenCalled();
  });

  it('colours each repo from its own pins', () => {
    bar(
      { repos: [repo('a', '/p/a', 'feat'), repo('b', '/p/b', 'feat')], foundCount: 0 },
      { pins: { '/p/a': { feat: '#ff0000' } } },
    );
    const a = within(screen.getByRole('group', { name: 'a' })).getByRole('button', { name: /^feat/ });
    const b = within(screen.getByRole('group', { name: 'b' })).getByRole('button', { name: /^feat/ });
    expect(a.getAttribute('style')).toContain('rgb(255, 0, 0)');
    expect(b.getAttribute('style') ?? '').not.toContain('rgb(255, 0, 0)');
  });

  it('shows "+N found" and opens the repos dialog', () => {
    const { onOpenRepos } = bar({ repos: [repo('', '/p', 'main')], foundCount: 2 });
    fireEvent.click(screen.getByRole('button', { name: /\+2 found/ }));
    expect(onOpenRepos).toHaveBeenCalled();
  });

  it('shows "N repos found" when nothing is watched yet', () => {
    bar({ repos: [], foundCount: 2 });
    expect(screen.getByRole('button', { name: /2 repos found/ })).toBeTruthy();
  });

  it('shows "no repos" when nothing was found', () => {
    bar({ repos: [], foundCount: 0 });
    expect(screen.getByRole('button', { name: /no repos/ })).toBeTruthy();
  });

  it('joins the repos button and the watch glyph into one button group', () => {
    bar({ repos: [repo('', '/p', 'main')], foundCount: 0 }, { watch: <button type="button" data-testid="watch" /> });
    const group = screen.getByRole('group', { name: 'Git' });
    expect(group.contains(screen.getByRole('button', { name: /manage repos/i }))).toBe(true);
    expect(group.contains(screen.getByTestId('watch'))).toBe(true);
    expect(group.querySelector('[data-testid="status-divider"]')).toBeNull();
  });

  it('sizes every segment to the bar', () => {
    bar(encompass);
    for (const b of screen.getAllByRole('button')) expect(b.className).toContain('text-[10px]');
  });
});
