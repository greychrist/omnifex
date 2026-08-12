import { describe, it, expect } from 'vitest';
import { parseWikilinks, resolveWikilink } from '@/lib/brainWikilinks';

// These nine cases are deliberately identical to
// electron/__tests__/brain-links.test.ts. The two implementations are twins
// across the process boundary; if one grammar drifts, one of these suites
// should go red.
describe('parseWikilinks', () => {
  it('finds a bare link', () => {
    expect(parseWikilinks('see [[Permission decider]] for detail')).toEqual(['Permission decider']);
  });

  it('takes the target, not the display text', () => {
    expect(parseWikilinks('see [[Subsystems/Sessions|the session layer]]')).toEqual([
      'Subsystems/Sessions',
    ]);
  });

  it('drops a heading anchor', () => {
    expect(parseWikilinks('[[Sessions#Lifecycle]]')).toEqual(['Sessions']);
  });

  it('finds several links across lines', () => {
    expect(parseWikilinks('[[A]]\n\ntext [[B]] more [[C]]')).toEqual(['A', 'B', 'C']);
  });

  it('dedupes repeated targets, preserving first-seen order', () => {
    expect(parseWikilinks('[[B]] [[A]] [[B]]')).toEqual(['B', 'A']);
  });

  it('trims surrounding whitespace inside the brackets', () => {
    expect(parseWikilinks('[[  Spaced  ]]')).toEqual(['Spaced']);
  });

  it('ignores an unclosed bracket', () => {
    expect(parseWikilinks('[[Unclosed')).toEqual([]);
  });

  it('ignores an empty target', () => {
    expect(parseWikilinks('[[]] [[ ]] [[|display]]')).toEqual([]);
  });

  it('returns nothing for a body with no links', () => {
    expect(parseWikilinks('# Title\n\nplain prose\n')).toEqual([]);
  });
});

describe('resolveWikilink', () => {
  const notes = ['Subsystems/Sessions.md', 'Projects/omnifex.md', 'Notes/Sessions.md'];

  it('resolves a bare title to a note path', () => {
    expect(resolveWikilink('omnifex', notes)).toBe('Projects/omnifex.md');
  });

  it('resolves a path-form target exactly', () => {
    expect(resolveWikilink('Subsystems/Sessions', notes)).toBe('Subsystems/Sessions.md');
  });

  it('is case-insensitive on the title', () => {
    expect(resolveWikilink('OMNIFEX', notes)).toBe('Projects/omnifex.md');
  });

  it('tolerates an explicit .md suffix', () => {
    expect(resolveWikilink('Projects/omnifex.md', notes)).toBe('Projects/omnifex.md');
  });

  it('returns null for a target that matches nothing', () => {
    expect(resolveWikilink('Nonexistent', notes)).toBeNull();
  });

  it('prefers an exact path match over an ambiguous title match', () => {
    expect(resolveWikilink('Notes/Sessions', notes)).toBe('Notes/Sessions.md');
  });

  it('returns null when a bare title is ambiguous', () => {
    // Two notes are titled Sessions; guessing one would silently open a
    // different note than the link's author meant.
    expect(resolveWikilink('Sessions', notes)).toBeNull();
  });

  it('returns null against an empty vault', () => {
    expect(resolveWikilink('anything', [])).toBeNull();
  });
});
