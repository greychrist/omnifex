import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '@/lib/unifiedDiff';
import { toSplitRows, type SplitPairRow, type SplitGapRow } from '@/lib/splitDiff';
import type { DiffFile } from '@/lib/unifiedDiff';

function fileFrom(patch: string): DiffFile {
  const parsed = parseUnifiedDiff(patch);
  if (!parsed || parsed.files.length === 0) throw new Error('patch did not parse');
  return parsed.files[0];
}

const pairs = (rows: ReturnType<typeof toSplitRows>): SplitPairRow[] =>
  rows.filter((r): r is SplitPairRow => r.kind === 'pair');

const gaps = (rows: ReturnType<typeof toSplitRows>): SplitGapRow[] =>
  rows.filter((r): r is SplitGapRow => r.kind === 'gap');

const SIMPLE = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '',
].join('\n');

describe('toSplitRows', () => {
  describe('context lines', () => {
    it('puts an unchanged line on both sides with both line numbers', () => {
      const rows = pairs(toSplitRows(fileFrom(SIMPLE)));
      const first = rows[0];
      expect(first.left).toEqual({ kind: 'ctx', number: 1, text: 'one' });
      expect(first.right).toEqual({ kind: 'ctx', number: 1, text: 'one' });
    });
  });

  describe('replacements', () => {
    it('pairs a removed line with the added line that replaced it', () => {
      const rows = pairs(toSplitRows(fileFrom(SIMPLE)));
      const changed = rows[1];
      expect(changed.left).toEqual({ kind: 'del', number: 2, text: 'two' });
      expect(changed.right).toEqual({ kind: 'add', number: 2, text: 'TWO' });
    });

    it('keeps the line numbers independent per side after a change', () => {
      const rows = pairs(toSplitRows(fileFrom(SIMPLE)));
      expect(rows[2].left.number).toBe(3);
      expect(rows[2].right.number).toBe(3);
    });
  });

  describe('uneven runs', () => {
    it('fills the right side when more lines were removed than added', () => {
      const patch = [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,4 +1,2 @@',
        ' keep',
        '-gone1',
        '-gone2',
        '-gone3',
        '+only',
        '',
      ].join('\n');
      const rows = pairs(toSplitRows(fileFrom(patch)));

      expect(rows[1].left.text).toBe('gone1');
      expect(rows[1].right.text).toBe('only');
      expect(rows[2].left.text).toBe('gone2');
      expect(rows[2].right).toEqual({ kind: 'none', number: null, text: '' });
      expect(rows[3].left.text).toBe('gone3');
      expect(rows[3].right.kind).toBe('none');
    });

    it('fills the left side when more lines were added than removed', () => {
      const patch = [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,2 +1,4 @@',
        ' keep',
        '-old',
        '+new1',
        '+new2',
        '+new3',
        '',
      ].join('\n');
      const rows = pairs(toSplitRows(fileFrom(patch)));

      expect(rows[1].left.text).toBe('old');
      expect(rows[1].right.text).toBe('new1');
      expect(rows[2].left).toEqual({ kind: 'none', number: null, text: '' });
      expect(rows[2].right.text).toBe('new2');
      expect(rows[3].left.kind).toBe('none');
      expect(rows[3].right.text).toBe('new3');
    });

    it('never puts a line number on a filler cell', () => {
      const patch = [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,1 +1,3 @@',
        '-old',
        '+a',
        '+b',
        '+c',
        '',
      ].join('\n');
      for (const row of pairs(toSplitRows(fileFrom(patch)))) {
        if (row.left.kind === 'none') expect(row.left.number).toBeNull();
        if (row.right.kind === 'none') expect(row.right.number).toBeNull();
      }
    });
  });

  describe('pure additions and deletions', () => {
    it('renders an added file as right-only rows', () => {
      const patch = [
        'diff --git a/n.ts b/n.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/n.ts',
        '@@ -0,0 +1,2 @@',
        '+alpha',
        '+beta',
        '',
      ].join('\n');
      const rows = pairs(toSplitRows(fileFrom(patch)));
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.left.kind === 'none')).toBe(true);
      expect(rows.map((r) => r.right.text)).toEqual(['alpha', 'beta']);
    });

    it('renders a deleted file as left-only rows', () => {
      const patch = [
        'diff --git a/d.ts b/d.ts',
        'deleted file mode 100644',
        '--- a/d.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-alpha',
        '-beta',
        '',
      ].join('\n');
      const rows = pairs(toSplitRows(fileFrom(patch)));
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.right.kind === 'none')).toBe(true);
      expect(rows.map((r) => r.left.text)).toEqual(['alpha', 'beta']);
    });
  });

  describe('gaps between hunks', () => {
    const TWO_HUNKS = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,3 +10,3 @@',
      ' ten',
      '-eleven',
      '+ELEVEN',
      ' twelve',
      '@@ -40,3 +40,3 @@',
      ' forty',
      '-fortyone',
      '+FORTYONE',
      ' fortytwo',
      '',
    ].join('\n');

    it('emits one gap row per hunk', () => {
      expect(gaps(toSplitRows(fileFrom(TWO_HUNKS)))).toHaveLength(2);
    });

    it('carries the hunk header so the gap row can show it', () => {
      const [first] = gaps(toSplitRows(fileFrom(TWO_HUNKS)));
      expect(first.header).toContain('@@ -10,3 +10,3 @@');
    });

    it('counts the lines hidden before the first hunk', () => {
      // Hunk starts at old line 10, so lines 1..9 are hidden.
      const [first] = gaps(toSplitRows(fileFrom(TWO_HUNKS)));
      expect(first.hiddenBefore).toBe(9);
    });

    it('counts the lines hidden between two hunks', () => {
      // First hunk covers old lines 10..12, second starts at 40 → 13..39 hidden.
      const [, second] = gaps(toSplitRows(fileFrom(TWO_HUNKS)));
      expect(second.hiddenBefore).toBe(27);
    });

    it('reports no hidden lines when a hunk starts at line 1', () => {
      const [first] = gaps(toSplitRows(fileFrom(SIMPLE)));
      expect(first.hiddenBefore).toBe(0);
    });
  });

  describe('degenerate input', () => {
    it('returns no rows for a binary file', () => {
      const patch = [
        'diff --git a/i.png b/i.png',
        'Binary files a/i.png and b/i.png differ',
        '',
      ].join('\n');
      expect(toSplitRows(fileFrom(patch))).toEqual([]);
    });
  });
});
