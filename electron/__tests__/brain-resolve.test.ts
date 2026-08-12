import { describe, it, expect } from 'vitest';
import { resolveEntityPath, type ExistingNote } from '../services/brain/resolve';

const existing: ExistingNote[] = [
  {
    path: 'Subsystems/Brain memory vault.md',
    title: 'Brain memory vault',
    aliases: ['brain vault', 'omnifex-brain-vault'],
  },
  { path: 'Projects/omnifex.md', title: 'omnifex', aliases: ['OmniFex'] },
];

const fallback = (name: string) => `Subsystems/${name}.md`;

describe('resolveEntityPath', () => {
  it('returns a fresh path when nothing matches', () => {
    expect(resolveEntityPath({ name: 'Distiller', aliases: [] }, existing, fallback)).toBe(
      'Subsystems/Distiller.md',
    );
  });

  it('reuses a note whose title matches exactly', () => {
    expect(
      resolveEntityPath({ name: 'Brain memory vault', aliases: [] }, existing, fallback),
    ).toBe('Subsystems/Brain memory vault.md');
  });

  it('reuses a note when the new name matches one of its aliases', () => {
    // The observed failure: two sessions produced 'Brain memory vault' and
    // 'omnifex-brain-vault' for one subsystem, and merge dedups by PATH, so
    // the second became a second note instead of an update.
    expect(
      resolveEntityPath({ name: 'omnifex-brain-vault', aliases: [] }, existing, fallback),
    ).toBe('Subsystems/Brain memory vault.md');
  });

  it("reuses a note when the new entity's alias matches the note's title", () => {
    expect(
      resolveEntityPath(
        { name: 'The Brain Vault', aliases: ['Brain memory vault'] },
        existing,
        fallback,
      ),
    ).toBe('Subsystems/Brain memory vault.md');
  });

  it('matches case-insensitively and ignores separators', () => {
    // 'brain-memory-vault' vs 'Brain memory vault' is the same entity spelled
    // by a model twice. Hyphen/space/case differences are the overwhelmingly
    // common way that happens.
    expect(
      resolveEntityPath({ name: 'brain-memory-vault', aliases: [] }, existing, fallback),
    ).toBe('Subsystems/Brain memory vault.md');
  });

  it('does not match on a shared substring', () => {
    // 'Brain' must NOT collapse into 'Brain memory vault'. Over-matching
    // merges genuinely distinct entities, which is worse than a duplicate —
    // a duplicate is visible and fixable, a bad merge silently loses one.
    expect(resolveEntityPath({ name: 'Brain', aliases: [] }, existing, fallback)).toBe(
      'Subsystems/Brain.md',
    );
  });

  it('prefers a title match over an alias match', () => {
    const ambiguous: ExistingNote[] = [
      { path: 'Topics/Alpha.md', title: 'Alpha', aliases: ['Beta'] },
      { path: 'Topics/Beta.md', title: 'Beta', aliases: [] },
    ];
    // Deterministic, and the more specific signal wins: a title is what the
    // note IS, an alias is only something it is also called.
    expect(resolveEntityPath({ name: 'Beta', aliases: [] }, ambiguous, fallback)).toBe(
      'Topics/Beta.md',
    );
  });

  it('is deterministic when two notes match equally well', () => {
    const dupes: ExistingNote[] = [
      { path: 'Topics/B.md', title: 'Thing', aliases: [] },
      { path: 'Topics/A.md', title: 'Thing', aliases: [] },
    ];
    // Sorted by path, so re-indexing cannot ping-pong an entity between two
    // notes and rewrite both on every run.
    expect(resolveEntityPath({ name: 'Thing', aliases: [] }, dupes, fallback)).toBe(
      'Topics/A.md',
    );
  });

  it('ignores empty aliases without matching everything', () => {
    const withBlank: ExistingNote[] = [
      { path: 'Topics/X.md', title: 'X', aliases: ['', '  '] },
    ];
    expect(resolveEntityPath({ name: 'Y', aliases: [''] }, withBlank, fallback)).toBe(
      'Subsystems/Y.md',
    );
  });

  it('falls back cleanly when the vault is empty', () => {
    expect(resolveEntityPath({ name: 'First', aliases: [] }, [], fallback)).toBe(
      'Subsystems/First.md',
    );
  });
});
