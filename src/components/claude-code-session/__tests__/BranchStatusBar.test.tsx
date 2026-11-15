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
    <BranchStatusBar snapshot={snapshot} pins={{}} aliases={{}} onOpenRepos={onOpenRepos} onViewChanges={onViewChanges} {...props} />,
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
  it('gives each repo a bar of its own, in the chat status bar\'s frame and type', () => {
    bar(encompass);
    const bars = screen.getAllByTestId('repo-bar');
    expect(bars).toHaveLength(2);
    for (const el of bars) {
      expect(el.className).toContain('text-[10px]');
      expect(el.className).toContain('font-mono');
      expect(el.className).toContain('rounded-md');
    }
    expect(bars[0].contains(screen.getByRole('group', { name: 'encompass-platform-backend' }))).toBe(true);
    expect(bars[1].contains(screen.getByRole('group', { name: 'encompass-platform-frontend' }))).toBe(true);
  });

  it('labels the whole row "git", muted like the chat bar\'s labels, outside the bars', () => {
    bar(encompass);
    const row = screen.getByTestId('branch-status-bar');
    const label = row.firstElementChild as HTMLElement;
    expect(label.textContent).toBe('git');
    expect(label.className).toContain('opacity-70');
    expect(label.className).toContain('text-[10px]');
    expect(label.closest('[data-testid="repo-bar"]')).toBeNull();
  });

  it('labels the row even when no repo is watched', () => {
    bar({ repos: [], foundCount: 2 });
    expect(screen.getByTestId('branch-status-bar').firstElementChild!.textContent).toBe('git');
  });

  it('lays the bars side by side, wrapping when they do not fit', () => {
    bar(encompass);
    const row = screen.getByTestId('branch-status-bar');
    expect(row.className).toContain('flex-wrap');
    expect(row.className).not.toContain('rounded-md');
  });

  it('puts the repos/refresh pair in a small bar of its own', () => {
    bar(encompass, { watch: <button type="button" data-testid="watch" /> });
    const gitBar = screen.getByTestId('git-bar');
    expect(gitBar.className).toContain('rounded-md');
    expect(gitBar.contains(screen.getByRole('group', { name: 'Git' }))).toBe(true);
    expect(gitBar.contains(screen.getByTestId('watch'))).toBe(true);
  });

  it('draws each repo as one capsule: its name, its main checkout, then each worktree', () => {
    bar(encompass);
    const be = screen.getByRole('group', { name: 'encompass-platform-backend' });
    const segments = within(be).getAllByRole('button').map((b) => b.textContent);
    expect(segments[0]).toBe('encompass-platform-backend');
    expect(segments[1]).toMatch(/^dev3$/);
    expect(segments[2]).toBe('test/wt-be-1');
    expect(segments[3]).toMatch(/^test\/wt-be-212$/);
    expect(within(screen.getByRole('group', { name: 'encompass-platform-frontend' })).getAllByRole('button')).toHaveLength(3);
  });


  it('draws every checkout as a badge of its own, with a gap between them', () => {
    bar(encompass);
    const be = screen.getByRole('group', { name: 'encompass-platform-backend' });
    expect(be.className).toMatch(/(^|\s)gap-1(\s|$)/);
    expect(be.className).not.toContain('[&>*+*]:border-l');
    for (const chip of within(be).getAllByRole('button').slice(1)) {
      expect(chip.className.split(' ')).toContain('rounded');
      expect(chip.className.split(' ')).toContain('border');
    }
  });

  // Like the chat bar's readouts (the model one): an icon in the bar's text
  // color, then the name in the muted label style.
  it('heads each repo with the folder-git icon (worktrees keep folder-git-2) and its name in the model readout\'s style', () => {
    bar(encompass);
    const name = screen.getByRole('button', { name: 'encompass-platform-backend' });
    const icon = name.querySelector('svg')!;
    expect(icon.getAttribute('class')).toMatch(/(^|\s)lucide-folder-git(\s|$)/);
    expect(icon.getAttribute('class')).toContain('h-3.5');
    expect(icon.getAttribute('class')).not.toMatch(/opacity|text-muted/);
    const label = name.querySelector('span')!;
    expect(label.textContent).toBe('encompass-platform-backend');
    expect(label.className).toContain('opacity-70');
    expect(name.className).not.toContain('text-muted-foreground');
  });

  it('shows a repo\'s alias in place of its name, the full name in the tooltip', () => {
    bar(encompass, { aliases: { '/e/encompass-platform-backend': 'api' } });
    const name = screen.getByRole('button', { name: 'api' });
    expect(name.getAttribute('title')).toContain('encompass-platform-backend');
    // The group keeps the full name for assistive tech.
    expect(screen.getByRole('group', { name: 'encompass-platform-backend' }).contains(name)).toBe(true);
  });

  it('shows the full folder name when a repo has no alias, never a guessed short one', () => {
    bar(encompass);
    expect(screen.getByRole('button', { name: 'encompass-platform-frontend' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'frontend' })).toBeNull();
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

  it('marks worktrees with a folder icon and the main checkout with a branch, each in its chip\'s color', () => {
    bar(encompass);
    const be = within(screen.getByRole('group', { name: 'encompass-platform-backend' })).getAllByRole('button');
    const mainIcon = be[1].querySelector('svg')!;
    const wtIcon = be[2].querySelector('svg')!;
    expect(mainIcon.getAttribute('class')).toContain('lucide-git-branch');
    expect(wtIcon.getAttribute('class')).toContain('lucide-folder-git-2');
    for (const icon of [mainIcon, wtIcon]) expect(icon.getAttribute('class')).not.toContain('text-foreground');
  });

  it('gives the repos button a cog folder', () => {
    bar({ repos: [repo('', '/p', 'main')], foundCount: 0 });
    const btn = screen.getByRole('button', { name: /manage repos/i });
    expect(btn.querySelector('svg')!.getAttribute('class')).toContain('lucide-folder-cog');
    // Same color as the refresh glyph beside it in the group.
    expect(btn.className.split(' ')).toContain('text-foreground');
  });

  it('opens a worktree\'s diff from its own segment', () => {
    const { onViewChanges } = bar(encompass);
    fireEvent.click(screen.getByRole('button', { name: /^test\/wt-be-2/ }));
    fireEvent.click(screen.getByRole('button', { name: /view changes/i }));
    expect(onViewChanges).toHaveBeenCalledWith('/e/worktrees/be-2', 'test/wt-be-2');
  });

  it('opens the repos dialog from a repo\'s name', () => {
    const { onOpenRepos } = bar(encompass);
    fireEvent.click(screen.getByRole('button', { name: 'encompass-platform-backend' }));
    expect(onOpenRepos).toHaveBeenCalled();
  });

  it('colors each repo from its own pins', () => {
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
  });

  // Clear, so the bar shows through the repos/refresh pair.
  it('leaves the repos/refresh group unfilled', () => {
    bar({ repos: [repo('', '/p', 'main')], foundCount: 0 });
    expect(screen.getByRole('group', { name: 'Git' }).className).not.toMatch(/(^|\s)bg-/);
  });

  it('sizes every segment to the bar', () => {
    bar(encompass);
    for (const b of screen.getAllByRole('button')) expect(b.className).toContain('text-[10px]');
  });
});
