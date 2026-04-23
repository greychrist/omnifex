import { describe, it, expect } from 'vitest';
import { formatFilePathForRule } from '../services/sessions/rule-paths';

const HOME = '/Users/alice';

describe('formatFilePathForRule', () => {
  // --- project-relative (wins over home) ---

  it('returns a project-anchored relative path when the file is inside the project root', () => {
    expect(formatFilePathForRule('/proj/src/foo.ts', '/proj', HOME)).toBe('/src/foo.ts');
  });

  it('handles nested directories correctly', () => {
    expect(formatFilePathForRule('/proj/.claude/commands/deploy.md', '/proj', HOME)).toBe(
      '/.claude/commands/deploy.md',
    );
  });

  it('returns "/" when the file path is the project root itself', () => {
    expect(formatFilePathForRule('/proj', '/proj', HOME)).toBe('/');
  });

  it('is tolerant of a trailing slash on the project path', () => {
    expect(formatFilePathForRule('/proj/src/foo.ts', '/proj/', HOME)).toBe('/src/foo.ts');
  });

  it('prefers project-relative over home-relative when both would match', () => {
    // Project is inside home — project match wins.
    expect(formatFilePathForRule('/Users/alice/proj/src/foo.ts', '/Users/alice/proj', HOME)).toBe('/src/foo.ts');
  });

  // --- home-relative (when outside project but under home) ---

  it('returns a home-relative path for files under home but outside the project', () => {
    expect(formatFilePathForRule('/Users/alice/other/bar.ts', '/Users/alice/proj', HOME)).toBe('~/other/bar.ts');
  });

  it('returns "~" for the home directory itself', () => {
    expect(formatFilePathForRule('/Users/alice', '/Users/alice/proj', HOME)).toBe('~');
  });

  it('is tolerant of a trailing slash on the home dir', () => {
    expect(
      formatFilePathForRule('/Users/alice/other/bar.ts', '/Users/alice/proj', '/Users/alice/'),
    ).toBe('~/other/bar.ts');
  });

  it('does NOT false-match a sibling home dir that shares a prefix', () => {
    // /Users/alice2 is NOT inside /Users/alice
    expect(formatFilePathForRule('/Users/alice2/foo.ts', '/Users/alice/proj', HOME)).toBe(
      '//Users/alice2/foo.ts',
    );
  });

  // --- absolute fallback (outside both project and home) ---

  it('returns a double-slash absolute path when the file is outside both project and home', () => {
    expect(formatFilePathForRule('/tmp/scratch.ts', '/Users/alice/proj', HOME)).toBe('//tmp/scratch.ts');
  });

  it('does NOT false-match a sibling dir that shares a prefix with the project root', () => {
    // /proj-other is NOT inside /proj — and not inside HOME either
    expect(formatFilePathForRule('/proj-other/foo.ts', '/proj', HOME)).toBe('//proj-other/foo.ts');
  });

  it('returns a home-relative path for a sibling-worktree file under home', () => {
    // Common worktree layout — project at ~/Repos/WIN, worktree at ~/Repos/worktrees/WIN/...
    expect(
      formatFilePathForRule(
        '/Users/greg/Repos/worktrees/WIN/WS-106/app/src/foo.ts',
        '/Users/greg/Repos/WIN',
        '/Users/greg',
      ),
    ).toBe('~/Repos/worktrees/WIN/WS-106/app/src/foo.ts');
  });

  // --- pass-through for already-relative inputs ---

  it('leaves home-relative (~/...) inputs unchanged', () => {
    expect(formatFilePathForRule('~/.ssh/id_rsa', '/proj', HOME)).toBe('~/.ssh/id_rsa');
  });

  it('leaves already-relative paths unchanged', () => {
    expect(formatFilePathForRule('src/foo.ts', '/proj', HOME)).toBe('src/foo.ts');
  });
});
