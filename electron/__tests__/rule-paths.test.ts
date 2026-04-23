import { describe, it, expect } from 'vitest';
import { formatFilePathForRule } from '../services/sessions/rule-paths';

describe('formatFilePathForRule', () => {
  it('returns a project-anchored relative path when the file is inside the project root', () => {
    expect(formatFilePathForRule('/proj/src/foo.ts', '/proj')).toBe('/src/foo.ts');
  });

  it('handles nested directories correctly', () => {
    expect(formatFilePathForRule('/proj/.claude/commands/deploy.md', '/proj')).toBe('/.claude/commands/deploy.md');
  });

  it('returns "/" when the file path is the project root itself', () => {
    expect(formatFilePathForRule('/proj', '/proj')).toBe('/');
  });

  it('is tolerant of a trailing slash on the project path', () => {
    expect(formatFilePathForRule('/proj/src/foo.ts', '/proj/')).toBe('/src/foo.ts');
  });

  it('returns a double-slash absolute path when the file is outside the project root', () => {
    expect(formatFilePathForRule('/Users/alice/elsewhere.ts', '/Users/alice/project')).toBe('//Users/alice/elsewhere.ts');
  });

  it('returns a double-slash absolute path for sibling-worktree files', () => {
    expect(
      formatFilePathForRule(
        '/Users/greg/Repos/worktrees/WIN/WS-106/app/src/foo.ts',
        '/Users/greg/Repos/WIN',
      ),
    ).toBe('//Users/greg/Repos/worktrees/WIN/WS-106/app/src/foo.ts');
  });

  it('does NOT false-match a sibling dir that shares a prefix with the project root', () => {
    // /proj-other is NOT inside /proj, even though it starts with "/proj"
    expect(formatFilePathForRule('/proj-other/foo.ts', '/proj')).toBe('//proj-other/foo.ts');
  });

  it('leaves home-relative (~/...) paths unchanged', () => {
    expect(formatFilePathForRule('~/.ssh/id_rsa', '/proj')).toBe('~/.ssh/id_rsa');
  });

  it('leaves already-relative paths unchanged', () => {
    expect(formatFilePathForRule('src/foo.ts', '/proj')).toBe('src/foo.ts');
  });
});
