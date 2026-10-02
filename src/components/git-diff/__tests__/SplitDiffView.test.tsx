// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';

// Prism highlighting is irrelevant to alignment, numbering and gap behaviour,
// and tokenising every line makes these tests an order of magnitude slower.
// The text still goes through the real component tree.
vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/hooks', () => ({ useTheme: () => ({ theme: 'dark' }) }));

import { SplitDiffView } from '@/components/git-diff/SplitDiffView';
import { parseUnifiedDiff, type DiffFile } from '@/lib/unifiedDiff';

afterEach(() => { cleanup(); });

function fileFrom(patch: string): DiffFile {
  const parsed = parseUnifiedDiff(patch);
  if (!parsed || parsed.files.length === 0) throw new Error('patch did not parse');
  return parsed.files[0];
}

const SIMPLE = fileFrom([
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '',
].join('\n'));

const rowsOf = (): HTMLElement[] => screen.getAllByRole('row');

describe('SplitDiffView', () => {
  describe('side-by-side layout', () => {
    it('puts the removed text on the left and its replacement on the right', () => {
      render(<SplitDiffView file={SIMPLE} language="ts" />);
      const changed = rowsOf().find((r) => within(r).queryByText('two'));
      expect(changed).toBeTruthy();
      const cells = within(changed as HTMLElement).getAllByRole('cell');
      expect(within(cells[1]).getByText('two')).toBeTruthy();
      expect(within(cells[3]).getByText('TWO')).toBeTruthy();
    });

    it('shows an unchanged line on both sides', () => {
      render(<SplitDiffView file={SIMPLE} language="ts" />);
      expect(screen.getAllByText('one')).toHaveLength(2);
    });

    it('numbers each side independently', () => {
      render(<SplitDiffView file={SIMPLE} language="ts" />);
      const changed = rowsOf().find((r) => within(r).queryByText('two')) as HTMLElement;
      const cells = within(changed).getAllByRole('cell');
      expect(cells[0].textContent).toBe('2');
      expect(cells[2].textContent).toBe('2');
    });

    it('marks which side is a removal and which an addition', () => {
      const { container } = render(<SplitDiffView file={SIMPLE} language="ts" />);
      expect(container.querySelector('[data-diff-side="del"]')).toBeTruthy();
      expect(container.querySelector('[data-diff-side="add"]')).toBeTruthy();
    });
  });

  describe('filler cells', () => {
    const LOPSIDED = fileFrom([
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
    ].join('\n'));

    it('leaves the left side blank where only the right side gained lines', () => {
      const { container } = render(<SplitDiffView file={LOPSIDED} language="ts" />);
      expect(container.querySelectorAll('[data-diff-side="none"]').length).toBe(2);
    });

    it('puts no line number on a filler cell', () => {
      render(<SplitDiffView file={LOPSIDED} language="ts" />);
      const row = rowsOf().find((r) => within(r).queryByText('new2')) as HTMLElement;
      const cells = within(row).getAllByRole('cell');
      expect(cells[0].textContent).toBe('');
    });
  });

  describe('gaps between hunks', () => {
    const TWO_HUNKS = fileFrom([
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
    ].join('\n'));

    it('shows how many lines are hidden at a gap', () => {
      render(<SplitDiffView file={TWO_HUNKS} language="ts" canExpandContext />);
      expect(screen.getByText(/27 lines/)).toBeTruthy();
    });

    it('asks for more context when the gap is clicked', () => {
      const onExpandContext = vi.fn();
      render(
        <SplitDiffView
          file={TWO_HUNKS}
          language="ts"
          canExpandContext
          onExpandContext={onExpandContext}
        />,
      );
      fireEvent.click(screen.getAllByRole('button', { name: /expand/i })[0]);
      expect(onExpandContext).toHaveBeenCalled();
    });

    it('offers no expand control once the whole file is shown', () => {
      render(<SplitDiffView file={TWO_HUNKS} language="ts" canExpandContext={false} />);
      expect(screen.queryByRole('button', { name: /expand/i })).toBeNull();
    });

    it('does not offer to expand a gap that hides nothing', () => {
      // The first hunk of SIMPLE starts at line 1 — there is nothing above it.
      render(<SplitDiffView file={SIMPLE} language="ts" canExpandContext />);
      expect(screen.queryByRole('button', { name: /expand/i })).toBeNull();
    });
  });

  describe('non-text files', () => {
    it('says a binary file cannot be shown rather than rendering nothing', () => {
      const binary = fileFrom([
        'diff --git a/i.png b/i.png',
        'Binary files a/i.png and b/i.png differ',
        '',
      ].join('\n'));
      render(<SplitDiffView file={binary} language="ts" />);
      expect(screen.getByText(/binary/i)).toBeTruthy();
    });
  });

  describe('large diffs', () => {
    it('does not mount every row of a very large file', () => {
      const lines: string[] = [
        'diff --git a/big.ts b/big.ts',
        '--- a/big.ts',
        '+++ b/big.ts',
        '@@ -1,600 +1,600 @@',
      ];
      for (let i = 1; i <= 300; i++) {
        lines.push(`-old${i}`);
        lines.push(`+new${i}`);
      }
      lines.push('');
      const { container } = render(
        <SplitDiffView file={fileFrom(lines.join('\n'))} language="ts" />,
      );

      // Two assertions, because "few rows in the DOM" alone would also pass
      // for a component that rendered nothing at all. The first proves the
      // windowed branch was taken; the second proves it windowed.
      const table = container.querySelector('[role="table"]');
      expect(table?.getAttribute('data-virtualized')).toBe('true');
      expect(table?.getAttribute('data-total-rows')).toBe('301');
      expect(screen.queryAllByRole('row').length).toBeLessThan(301);
    });

    it('renders a small diff directly rather than windowing it', () => {
      const { container } = render(<SplitDiffView file={SIMPLE} language="ts" />);
      const table = container.querySelector('[role="table"]');
      expect(table?.getAttribute('data-virtualized')).toBe('false');
      expect(screen.getAllByRole('row')).toHaveLength(4);
    });
  });

  describe('resizing the two sides', () => {
    const KEY = 'omnifex.gitDiff.splitRatio';
    // 1104px wide: two 52px gutters leave exactly 1000px of code, so a
    // pointer at x = 52 + 1000·f puts the divider at fraction f.
    beforeEach(() => {
      localStorage.clear();
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
        { left: 0, top: 0, right: 1104, bottom: 600, width: 1104, height: 600 } as DOMRect,
      );
    });
    afterEach(() => { vi.restoreAllMocks(); });

    const ratio = (): string =>
      screen.getByTestId('split-diff').style.getPropertyValue('--diff-left');
    const divider = (): HTMLElement =>
      screen.getByRole('separator', { name: /resize the old and new sides/i });
    const drag = (to: number): void => {
      fireEvent.mouseDown(divider(), { clientX: 552 });
      fireEvent.mouseMove(window, { clientX: to });
      fireEvent.mouseUp(window);
    };

    it('splits evenly by default', () => {
      render(<SplitDiffView file={SIMPLE} language="ts" />);
      expect(ratio()).toBe('0.5');
    });

    it('moves the divider to where it is dragged', () => {
      render(<SplitDiffView file={SIMPLE} language="ts" />);
      drag(352);
      expect(ratio()).toBe('0.3');
    });

    it('never collapses a side completely', () => {
      render(<SplitDiffView file={SIMPLE} language="ts" />);
      drag(0);
      expect(Number(ratio())).toBeGreaterThan(0);
      drag(5000);
      expect(Number(ratio())).toBeLessThan(1);
    });

    it('resets to an even split on double-click', () => {
      render(<SplitDiffView file={SIMPLE} language="ts" />);
      drag(352);
      fireEvent.doubleClick(divider());
      expect(ratio()).toBe('0.5');
    });

    it('remembers the split for the next file', () => {
      const first = render(<SplitDiffView file={SIMPLE} language="ts" />);
      drag(752);
      first.unmount();
      render(<SplitDiffView file={SIMPLE} language="ts" />);
      expect(ratio()).toBe('0.7');
      expect(localStorage.getItem(KEY)).toBe('0.7');
    });
  });
});
