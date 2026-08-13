import { describe, expect, it } from 'vitest';
import { BYTES_PER_TOKEN, computeVaultStats } from '../services/brain/stats';
import type { ParsedNote } from '../services/brain/types';

function note(entries: number, extra: Partial<ParsedNote['frontmatter']> = {}): ParsedNote {
  const lines = Array.from({ length: entries }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return `- **2026-01-${day}**: Entry ${String(i + 1)}.`;
  });
  return {
    frontmatter: {
      type: 'Subsystem',
      aliases: [],
      keywords: [],
      created: '2026-01-01',
      updated: '2026-02-01',
      sources: [],
      ...extra,
    },
    body: ['# N', '', '## Timeline', ...lines, ''].join('\n'),
  };
}

describe('computeVaultStats', () => {
  it('reports zeroes for an empty vault without dividing by zero', () => {
    const s = computeVaultStats([], '2026-03-01');
    expect(s.noteCount).toBe(0);
    expect(s.totalBytes).toBe(0);
    expect(s.medianBytes).toBe(0);
    expect(s.largestNote).toBeNull();
    expect(s.estimatedTokens.vault).toBe(0);
  });

  it('counts notes by type', () => {
    const s = computeVaultStats(
      [
        { relPath: 'Subsystems/A.md', note: note(1) },
        { relPath: 'Projects/B.md', note: note(1, { type: 'Project' }) },
        { relPath: 'Notes/C.md', note: note(1, { type: 'Note' }) },
      ],
      '2026-03-01',
    );
    expect(s.noteCount).toBe(3);
    expect(s.byType.Subsystem).toBe(1);
    expect(s.byType.Project).toBe(1);
    expect(s.byType.Note).toBe(1);
  });

  it('names the largest note and estimates its tokens', () => {
    const s = computeVaultStats(
      [
        { relPath: 'Subsystems/Small.md', note: note(1) },
        { relPath: 'Subsystems/Big.md', note: note(40) },
      ],
      '2026-03-01',
    );
    expect(s.largestNote).toBe('Subsystems/Big.md');
    expect(s.estimatedTokens.largest).toBe(Math.round(s.largestBytes / BYTES_PER_TOKEN));
  });

  it('buckets notes by Timeline length', () => {
    const s = computeVaultStats(
      [
        { relPath: 'a.md', note: note(0) },
        { relPath: 'b.md', note: note(2) },
        { relPath: 'c.md', note: note(5) },
        { relPath: 'd.md', note: note(10) },
        { relPath: 'e.md', note: note(30) },
      ],
      '2026-03-01',
    );
    expect(s.timelineBuckets).toEqual([
      { label: 'none', count: 1 },
      { label: '1–3', count: 1 },
      { label: '4–7', count: 1 },
      { label: '8–15', count: 1 },
      { label: '16+', count: 1 },
    ]);
  });

  it('counts how many notes qualify right now', () => {
    const s = computeVaultStats(
      [
        { relPath: 'a.md', note: note(3) },
        { relPath: 'b.md', note: note(12) },
        { relPath: 'c.md', note: note(12, { curated_at: '2026-02-28', updated: '2026-02-01' }) },
      ],
      '2026-03-01',
    );
    // Only b: a is too short, c has not changed since it was curated.
    expect(s.qualifyingCount).toBe(1);
  });

  it('lists recently curated notes, newest first', () => {
    const s = computeVaultStats(
      [
        { relPath: 'a.md', note: note(1, { curated_at: '2026-02-01' }) },
        { relPath: 'b.md', note: note(1) },
        { relPath: 'c.md', note: note(1, { curated_at: '2026-02-20' }) },
      ],
      '2026-03-01',
    );
    expect(s.recentlyCurated).toEqual([
      { relPath: 'c.md', curatedAt: '2026-02-20' },
      { relPath: 'a.md', curatedAt: '2026-02-01' },
    ]);
  });

  it('takes the median as the middle note by size', () => {
    const s = computeVaultStats(
      [
        { relPath: 'a.md', note: note(1) },
        { relPath: 'b.md', note: note(10) },
        { relPath: 'c.md', note: note(40) },
      ],
      '2026-03-01',
    );
    expect(s.medianBytes).toBeGreaterThan(0);
    expect(s.medianBytes).toBeLessThan(s.largestBytes);
  });
});
