import { describe, it, expect } from 'vitest';
import { linkMatchesNote, parseWikilinks } from '../services/brain/links';

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

describe('linkMatchesNote', () => {
  it('matches a bare title against a note path', () => {
    expect(linkMatchesNote('Sessions', 'Subsystems/Sessions.md')).toBe(true);
  });

  it('matches a path-form target', () => {
    expect(linkMatchesNote('Subsystems/Sessions', 'Subsystems/Sessions.md')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(linkMatchesNote('SESSIONS', 'Subsystems/Sessions.md')).toBe(true);
  });

  it('tolerates an explicit .md suffix on the target', () => {
    expect(linkMatchesNote('Sessions.md', 'Subsystems/Sessions.md')).toBe(true);
  });

  it('does not match a different note', () => {
    expect(linkMatchesNote('Permissions', 'Subsystems/Sessions.md')).toBe(false);
  });
});
