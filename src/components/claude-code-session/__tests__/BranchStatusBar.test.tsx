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
  it('puts everything in one container, the chat status bar\'s own', () => {
    bar(encompass, { watch: <button type="button" data-testid="watch" /> });
    const box = screen.getByTestId('branch-status-bar');
    expect(box.className).toContain('rounded-md');
    expect(box.className).toContain('text-[10px]');
    expect(box.className).toContain('font-mono');
    for (const name of ['encompass-platform-backend', 'encompass-platform-frontend', 'Git']) {
      expect(box.contains(screen.getByRole('group', { name }))).toBe(true);
    }
    expect(box.contains(screen.getByTestId('watch'))).toBe(true);
    expect(screen.queryAllByTestId('repo-bar')).toHaveLength(0);
  });

  // Only as wide as its contents; the repos/refresh pair ends it, set off from
  // the table by a little space and a rule.
  it('sizes to its contents, the repos/refresh pair ruled off at the end', () => {
    bar(encompass);
    const cls = screen.getByTestId('branch-status-bar').className.split(' ');
    expect(cls).not.toContain('w-full');
    expect(cls).toContain('w-fit');
    expect(cls).toContain('max-w-full');
    const slot = screen.getByRole('group', { name: 'Git' }).parentElement!;
    expect(slot.className.split(' ')).not.toContain('ml-auto');
    // Full height, like the rule after the label, so it spans every repo row.
    const rule = screen.getByTestId('git-divider');
    expect(rule.parentElement).toBe(screen.getByTestId('branch-status-bar'));
    expect(rule.nextElementSibling).toBe(slot);
    expect(rule.className.split(' ')).toEqual(expect.arrayContaining(['self-stretch', 'h-auto', 'ml-2']));
  });

  it('lays repos out as a table: a column for the name, then one per checkout', () => {
    bar(encompass);
    const table = screen.getByTestId('repo-rows');
    // backend has the most checkouts (main + 2 worktrees).
    expect(table.style.gridTemplateColumns).toBe('auto repeat(3, auto)');
    // Every row fills every column; frontend's missing worktree is an empty cell.
    const cells = table.querySelectorAll('[data-cell]');
    expect(cells).toHaveLength(8);
    const fe = screen.getByRole('group', { name: 'encompass-platform-frontend' });
    const feCells = fe.querySelectorAll('[data-cell]');
    expect(feCells[3].textContent).toBe('');
  });

  it('divides a repo\'s name and each of its checkouts', () => {
    bar(encompass);
    const be = screen.getByRole('group', { name: 'encompass-platform-backend' });
    // name | dev | wt-be-1 | wt-be-2
    expect(within(be).getAllByTestId('status-divider')).toHaveLength(3);
  });

  it('heads the row with a git-pull-request icon and "repos", like a status readout', () => {
    bar(encompass);
    const label = screen.getByTestId('branch-status-bar').firstElementChild as HTMLElement;
    expect(label.textContent).toBe('repos');
    expect(label.querySelector('svg')!.getAttribute('class')).toContain('lucide-git-pull-request');
    expect(label.querySelector('svg')!.getAttribute('class')).toContain('h-3.5');
    const text = Array.from(label.querySelectorAll('span')).find((el) => el.textContent === 'repos')!;
    expect(text.className).toContain('opacity-70');
    // A color of its own, as each readout above has.
    expect(label.className.split(' ')).toContain('text-purple-400');
    expect(label.closest('[data-testid="repo-bar"]')).toBeNull();
  });

  // The repos/refresh pair is the tallest thing on a one-line bar; top-aligned,
  // the label and the lone row sat high beside it.
  it('centers a one-repo bar vertically, and top-aligns a taller one', () => {
    bar({ repos: [repo('', '/p/omnifex', 'main')], foundCount: 0 });
    expect(screen.getByTestId('branch-status-bar').className.split(' ')).toContain('items-center');
    cleanup();
    bar({ repos: [], foundCount: 2 });
    expect(screen.getByTestId('branch-status-bar').className.split(' ')).toContain('items-center');
    cleanup();
    bar(encompass);
    const cls = screen.getByTestId('branch-status-bar').className.split(' ');
    expect(cls).toContain('items-start');
    expect(cls).not.toContain('items-center');
  });

  it('rules the label off from the repo table with a divider the table\'s full height', () => {
    bar(encompass);
    const box = screen.getByTestId('branch-status-bar');
    const rule = box.children[1] as HTMLElement;
    expect(rule.getAttribute('data-testid')).toBe('label-divider');
    expect(rule.className).toContain('self-stretch');
    expect(box.children[2]).toBe(screen.getByTestId('repo-rows'));
  });

  it('heads the row even when no repo is watched', () => {
    bar({ repos: [], foundCount: 2 });
    expect(screen.getByTestId('branch-status-bar').firstElementChild!.textContent).toBe('repos');
  });

  it('draws each repo as one capsule: its name, its main checkout, then each worktree', () => {
    bar(encompass);
    const be = screen.getByRole('group', { name: 'encompass-platform-backend' });
    const segments = within(be).getAllByRole('button').map((b) => b.textContent);
    expect(segments[0]).toBe('nameencompass-platform-backend');
    expect(segments[1]).toMatch(/^branchdev3$/);
    expect(segments[2]).toBe('worktreetest/wt-be-1');
    expect(segments[3]).toMatch(/^worktreetest\/wt-be-212$/);
    expect(within(screen.getByRole('group', { name: 'encompass-platform-frontend' })).getAllByRole('button')).toHaveLength(3);
  });


  it('draws every checkout as colored text, like a status readout, not a badge', () => {
    bar(encompass, { pins: { '/e/encompass-platform-backend': { 'test/wt-be-1': '#ff0000' } } });
    const be = screen.getByRole('group', { name: 'encompass-platform-backend' });
    const chips = within(be).getAllByRole('button').slice(1);
    for (const chip of chips) {
      expect(chip.className).not.toMatch(/(^|\s)border(\s|$)/);
      expect(chip.getAttribute('style') ?? '').not.toContain('background');
    }
    expect(chips[1].getAttribute('style')).toContain('rgb(255, 0, 0)');
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
    expect(name.className).not.toContain('text-muted-foreground');
  });

  // Like the readouts above: a muted `label:`, then the value at full strength.
  it('labels each cell like a status readout: name, branch, worktree', () => {
    bar(encompass);
    const be = within(screen.getByRole('group', { name: 'encompass-platform-backend' })).getAllByRole('button');
    const labelOf = (el: HTMLElement) => Array.from(el.querySelectorAll('span')).find((x) => x.className.includes("after:content-[':']"))!;
    expect(labelOf(be[0]).textContent).toBe('name');
    expect(labelOf(be[1]).textContent).toBe('branch');
    expect(labelOf(be[2]).textContent).toBe('worktree');
    expect(labelOf(be[3]).textContent).toBe('worktree');
    // The repo name is the value now, not a dimmed label.
    const value = Array.from(be[0].querySelectorAll('span')).find((x) => x.textContent === 'encompass-platform-backend')!;
    expect(value.className).not.toContain('opacity-70');
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
