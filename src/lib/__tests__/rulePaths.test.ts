import { describe, it, expect } from 'vitest';
import { formatFilePathForRule } from '../rulePaths';

const HOME = '/Users/alice';

describe('formatFilePathForRule', () => {
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
    expect(formatFilePathForRule('/Users/alice/proj/src/foo.ts', '/Users/alice/proj', HOME)).toBe('/src/foo.ts');
  });

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

  it('leaves home-relative (~/...) inputs unchanged', () => {
    expect(formatFilePathForRule('~/.ssh/id_rsa', '/proj', HOME)).toBe('~/.ssh/id_rsa');
  });

  it('leaves already-relative paths unchanged', () => {
    expect(formatFilePathForRule('src/foo.ts', '/proj', HOME)).toBe('src/foo.ts');
  });

  // Edit(<content>) is a gitignore-style glob, so metacharacters are
  // bracket-quoted, the CLI's own idiom (2.1.260: "[(]" or "[)]").

  it('escapes a bracket so a literal [dir] is not read as a character class', () => {
    expect(formatFilePathForRule('/Users/alice/[archive]/x.ts', '/proj', HOME)).toBe(
      '~/[[]archive]/x.ts',
    );
  });

  it('escapes an unclosed bracket, which used to break every edit in the session', () => {
    expect(formatFilePathForRule('/Users/alice/report[1.pdf', '/proj', HOME)).toBe(
      '~/report[[]1.pdf',
    );
  });

  it('escapes * and ? so they match themselves', () => {
    expect(formatFilePathForRule('/proj/a*b?c.ts', '/proj', HOME)).toBe('/a[*]b[?]c.ts');
  });

  it('escapes metacharacters in pass-through (home-relative and relative) inputs too', () => {
    expect(formatFilePathForRule('~/notes/[wip].md', '/proj', HOME)).toBe('~/notes/[[]wip].md');
    expect(formatFilePathForRule('src/a[1].ts', '/proj', HOME)).toBe('src/a[[]1].ts');
  });

  it('leaves parentheses alone — CLI 2.1.260 reads them as literal inside a rule', () => {
    // CLI 2.1.260: "parentheses inside the content are literal."
    expect(formatFilePathForRule('/Users/alice/Brain (backup)/n.md', '/proj', HOME)).toBe(
      '~/Brain (backup)/n.md',
    );
  });
});
