import { describe, it, expect, vi } from 'vitest';
import { discoverWorktrees, parseWorktreeListPorcelain } from '../services/git-worktrees';

describe('parseWorktreeListPorcelain', () => {
  it('extracts worktree paths from canonical porcelain output', () => {
    const output = [
      'worktree /repo/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/wt-a',
      'HEAD def456',
      'branch refs/heads/feature-a',
      '',
      'worktree /repo/wt-b',
      'HEAD ghi789',
      'detached',
      '',
    ].join('\n');

    expect(parseWorktreeListPorcelain(output)).toEqual([
      '/repo/main',
      '/repo/wt-a',
      '/repo/wt-b',
    ]);
  });

  it('handles bare and locked worktrees', () => {
    const output = [
      'worktree /repo/bare',
      'bare',
      '',
      'worktree /repo/locked',
      'HEAD abc',
      'branch refs/heads/main',
      'locked',
      '',
    ].join('\n');

    expect(parseWorktreeListPorcelain(output)).toEqual([
      '/repo/bare',
      '/repo/locked',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseWorktreeListPorcelain('')).toEqual([]);
  });

  it('ignores non-worktree lines', () => {
    const output = 'HEAD abc\nbranch refs/heads/main\n';
    expect(parseWorktreeListPorcelain(output)).toEqual([]);
  });
});

describe('discoverWorktrees', () => {
  const makeOutput = (paths: string[]) =>
    paths.map((p) => `worktree ${p}\n`).join('\n');

  it('returns sibling worktrees, excluding the cwd itself', () => {
    const exec = vi.fn().mockReturnValue(makeOutput(['/repo/main', '/repo/wt-a', '/repo/wt-b']));
    const fileExists = vi.fn().mockReturnValue(true);

    const result = discoverWorktrees('/repo/main', { exec, fileExists });

    expect(result).toEqual(['/repo/wt-a', '/repo/wt-b']);
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/main', 'worktree', 'list', '--porcelain'],
      expect.objectContaining({ cwd: '/repo/main', timeout: 2000 }),
    );
  });

  it('excludes stale (non-existent) worktree paths', () => {
    const exec = vi.fn().mockReturnValue(makeOutput(['/repo/main', '/repo/wt-gone', '/repo/wt-alive']));
    const fileExists = vi.fn((p: string) => p !== '/repo/wt-gone');

    const result = discoverWorktrees('/repo/main', { exec, fileExists });

    expect(result).toEqual(['/repo/wt-alive']);
  });

  it('returns empty array when git exits non-zero (not a git repo)', () => {
    const exec = vi.fn().mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    const result = discoverWorktrees('/not-a-repo', { exec });

    expect(result).toEqual([]);
  });

  it('returns empty array when git is not installed', () => {
    const exec = vi.fn().mockImplementation(() => {
      const err: any = new Error('spawn git ENOENT');
      err.code = 'ENOENT';
      throw err;
    });

    expect(discoverWorktrees('/some/path', { exec })).toEqual([]);
  });

  it('deduplicates worktree paths', () => {
    const exec = vi.fn().mockReturnValue(makeOutput(['/repo/main', '/repo/wt-a', '/repo/wt-a']));
    const fileExists = vi.fn().mockReturnValue(true);

    const result = discoverWorktrees('/repo/main', { exec, fileExists });

    expect(result).toEqual(['/repo/wt-a']);
  });

  it('handles cwd matching via path normalization (trailing slash)', () => {
    const exec = vi.fn().mockReturnValue(makeOutput(['/repo/main', '/repo/wt-a']));
    const fileExists = vi.fn().mockReturnValue(true);

    const result = discoverWorktrees('/repo/main/', { exec, fileExists });

    expect(result).toEqual(['/repo/wt-a']);
  });

  it('returns the main checkout as a sibling when cwd is a secondary worktree', () => {
    const exec = vi.fn().mockReturnValue(makeOutput(['/repo/main', '/repo/wt-a', '/repo/wt-b']));
    const fileExists = vi.fn().mockReturnValue(true);

    const result = discoverWorktrees('/repo/wt-a', { exec, fileExists });

    expect(result).toEqual(['/repo/main', '/repo/wt-b']);
  });
});
