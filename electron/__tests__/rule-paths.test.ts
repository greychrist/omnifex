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

  // --- glob metacharacter escaping ---
  //
  // The rule content this returns goes straight into `Edit(<content>)`, which
  // the CLI matches as a gitignore-style glob. A path is a literal, so every
  // glob metacharacter in it has to be spelled as one. The CLI's own escape
  // idiom is bracket-quoting — CLI 2.1.260 tells users to "spell a literal
  // parenthesis as [(] or [)]" — so `*`, `?` and `[` get the same treatment.
  //
  // Before this, an unclosed `[` produced an uncompilable pattern that made
  // EVERY file edit in the session fail with "Invalid regular expression"
  // (fixed CLI-side in 2.1.260, but only for users on that build), and a
  // balanced `[...]` silently matched nothing because it read as a character
  // class.

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
    // "Rules take the form Tool or Tool(content) and must end at the closing
    // ')'; parentheses inside the content are literal." Escaping them would
    // make the rule wrong, not safer.
    expect(formatFilePathForRule('/Users/alice/Brain (backup)/n.md', '/proj', HOME)).toBe(
      '~/Brain (backup)/n.md',
    );
  });
});
