import { describe, it, expect } from 'vitest';
import {
  parseWikilinks,
  resolveWikilink,
  wikilinkTarget,
  wikilinksToMarkdown,
  WIKILINK_SCHEME,
} from '@/lib/brainWikilinks';

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

describe('wikilinksToMarkdown', () => {
  it('rewrites a bare link as a markdown link', () => {
    expect(wikilinksToMarkdown('see [[Sessions]]')).toBe(
      `see [Sessions](${WIKILINK_SCHEME}Sessions)`,
    );
  });

  it('keeps the display text and links the target', () => {
    expect(wikilinksToMarkdown('[[Subsystems/Sessions|the layer]]')).toBe(
      `[the layer](${WIKILINK_SCHEME}Subsystems%2FSessions)`,
    );
  });

  it('encodes a target containing spaces', () => {
    expect(wikilinksToMarkdown('[[Permission decider]]')).toBe(
      `[Permission decider](${WIKILINK_SCHEME}Permission%20decider)`,
    );
  });

  it('leaves prose without links untouched', () => {
    expect(wikilinksToMarkdown('# Title\n\nplain\n')).toBe('# Title\n\nplain\n');
  });

  it('does not rewrite inside a fenced code block', () => {
    const src = 'before [[A]]\n\n```\nconst x = [[B]];\n```\n\nafter [[C]]';
    const out = wikilinksToMarkdown(src);
    expect(out).toContain('const x = [[B]];');
    expect(out).toContain(`[A](${WIKILINK_SCHEME}A)`);
    expect(out).toContain(`[C](${WIKILINK_SCHEME}C)`);
  });

  it('leaves an empty target alone', () => {
    expect(wikilinksToMarkdown('[[]]')).toBe('[[]]');
  });
});

describe('wikilinkTarget', () => {
  it('decodes a wikilink href', () => {
    expect(wikilinkTarget(`${WIKILINK_SCHEME}Permission%20decider`)).toBe('Permission decider');
  });

  it('returns null for an ordinary link', () => {
    expect(wikilinkTarget('https://example.com')).toBeNull();
  });

  it('returns null for a missing href', () => {
    expect(wikilinkTarget(undefined)).toBeNull();
  });
});
