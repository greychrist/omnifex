// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainSourcesTable, comparePaths, rowId } from '@/components/brain/BrainSourcesTable';
import type { BrainSourceSummary } from '@/lib/api';

function row(over: Partial<BrainSourceSummary> = {}): BrainSourceSummary {
  return {
    accountId: 1,
    sourceId: 'session',
    itemKey: 'sess-a',
    label: '/Users/greg/Repos/personal/WIN',
    mtimeMs: Date.parse('2026-08-01T00:00:00Z'),
    size: 40_960,
    admitted: true,
    reason: '4 prompts',
    status: null,
    changed: true,
    excluded: false,
    ...over,
  };
}

const ROWS = [
  row({ itemKey: 'aaa', mtimeMs: Date.parse('2026-08-01T00:00:00Z'), size: 1_000 }),
  row({ itemKey: 'bbb', mtimeMs: Date.parse('2026-08-10T00:00:00Z'), size: 9_000_000 }),
  row({
    itemKey: 'ccc',
    label: '/private/tmp/brain-probe',
    mtimeMs: Date.parse('2026-08-05T00:00:00Z'),
    size: 5_000,
    status: 'indexed',
    changed: false,
  }),
];

/** One row of each kind, newest first, for the Type-column tests. */
const MIXED = [
  row({ itemKey: 'sess', sourceId: 'session', mtimeMs: Date.parse('2026-08-03T00:00:00Z') }),
  row({ itemKey: 'mem', sourceId: 'auto-memory', mtimeMs: Date.parse('2026-08-02T00:00:00Z') }),
  row({ itemKey: 'repo', sourceId: 'repo', mtimeMs: Date.parse('2026-08-01T00:00:00Z') }),
];

/** Wraps the controlled selection so tests can drive it like the real pane. */
function Harness({ rows = ROWS }: { rows?: BrainSourceSummary[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <>
      <BrainSourcesTable
        rows={rows}
        selected={selected}
        onSelectedChange={setSelected}
        activeItemKey={null}
        onOpen={vi.fn()}
      />
      <div data-testid="count">{selected.size}</div>
    </>
  );
}

/**
 * Row order, by item key.
 *
 * Read off each row's select checkbox rather than a cell: the session id has
 * no column any more, and identifying rows by a rendered cell would couple
 * every ordering test to the column layout.
 */
function itemCells(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getByRole('checkbox').getAttribute('aria-label')?.replace('Select ', '') ?? '');
}

afterEach(() => { cleanup(); });

describe('BrainSourcesTable', () => {
  it('defaults to newest first', () => {
    render(<Harness />);
    expect(itemCells()).toEqual(['bbb', 'ccc', 'aaa']);
  });

  it('sorts by size, and flips direction on a second click', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^size/i }));
    expect(itemCells()).toEqual(['bbb', 'ccc', 'aaa']);
    fireEvent.click(screen.getByRole('button', { name: /^size/i }));
    expect(itemCells()).toEqual(['aaa', 'ccc', 'bbb']);
  });

  it('filters on free text across item key, project and type', () => {
    render(<Harness />);
    // The key has no column, but pasting a session id must still find it.
    fireEvent.change(screen.getByLabelText(/filter sessions/i), { target: { value: 'ccc' } });
    expect(itemCells()).toEqual(['ccc']);

    fireEvent.change(screen.getByLabelText(/filter sessions/i), { target: { value: 'tmp' } });
    expect(itemCells()).toEqual(['ccc']);

    fireEvent.change(screen.getByLabelText(/filter sessions/i), { target: { value: 'session' } });
    expect(itemCells()).toEqual(['bbb', 'ccc', 'aaa']);
  });

  /**
   * Auto-memory notes and repo instruction files are `.md` on disk, so without
   * a Type column a Markdown file is indistinguishable from a conversation.
   */
  it('names the kind of each row, so a .md file is not read as a session', () => {
    render(<Harness rows={MIXED} />);
    const types = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[2].textContent ?? '');
    expect(types).toEqual(['Session', 'Memory', 'Repo file']);
  });

  it('does not show the session id', () => {
    render(<Harness />);
    expect(screen.queryByRole('columnheader', { name: /session/i })).toBeNull();
    expect(screen.queryByText('aaa')).toBeNull();
  });

  it('sorts by type', () => {
    render(<Harness rows={MIXED} />);
    fireEvent.click(screen.getByRole('button', { name: /^type/i }));
    expect(itemCells()).toEqual(['sess', 'repo', 'mem']);
  });

  it('filters by project from the popover', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/filter by project/i));
    fireEvent.click(screen.getByLabelText('Show /Users/greg/Repos/personal/WIN'));
    expect(itemCells()).toEqual(['ccc']);
  });

  it('reports how many projects are showing once some are hidden', () => {
    render(<Harness />);
    const trigger = screen.getByLabelText(/filter by project/i);
    expect(trigger.textContent).toBe('All projects');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByLabelText('Show /private/tmp/brain-probe'));
    expect(trigger.textContent).toBe('1 of 2 projects');
  });

  it('hides and restores every project at once', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/filter by project/i));
    fireEvent.click(screen.getByRole('button', { name: /hide all/i }));
    expect(screen.getByText(/nothing matches/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /show all/i }));
    expect(itemCells()).toEqual(['bbb', 'ccc', 'aaa']);
  });

  it('filters by status', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText(/filter by status/i), { target: { value: 'indexed' } });
    expect(itemCells()).toEqual(['ccc']);
  });

  it('selects and deselects a single row', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Select aaa'));
    expect(screen.getByTestId('count').textContent).toBe('1');
    fireEvent.click(screen.getByLabelText('Select aaa'));
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  /**
   * The rule that would have prevented the original accident: a select-all
   * that silently reaches past what is on screen is how a user indexes 158
   * sessions having meant to index one.
   */
  it('select-all covers only the filtered rows', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/filter by project/i));
    fireEvent.click(screen.getByLabelText('Show /Users/greg/Repos/personal/WIN'));
    fireEvent.click(screen.getByLabelText(/select all shown/i));
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('select-all toggles off when everything shown is already selected', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/select all shown/i));
    expect(screen.getByTestId('count').textContent).toBe('3');
    fireEvent.click(screen.getByLabelText(/select all shown/i));
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('reports how many rows the filter is showing', () => {
    render(<Harness />);
    expect(screen.getByText('3 of 3')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/filter sessions/i), { target: { value: 'ccc' } });
    expect(screen.getByText('1 of 3')).toBeTruthy();
  });

  it('says so when a filter matches nothing', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText(/filter sessions/i), { target: { value: 'zzz' } });
    expect(screen.getByText(/nothing matches/i)).toBeTruthy();
  });

  it('renders megabytes for a large session', () => {
    render(<Harness />);
    expect(screen.getByText('8.6 MB')).toBeTruthy();
  });

  it('gives every row a unique id across adapters', () => {
    expect(rowId(row({ sourceId: 'session', itemKey: 'x' })))
      .not.toBe(rowId(row({ sourceId: 'auto-memory', itemKey: 'x' })));
  });

  it('shows the whole folder path, unabridged', () => {
    render(<Harness />);
    const cells = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[1].textContent ?? '');
    expect(cells).toContain('/Users/greg/Repos/personal/WIN');
    expect(cells).toContain('/private/tmp/brain-probe');
  });

  it('lists projects alphabetically in the filter, with their counts', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/filter by project/i));
    const shown = screen
      .getAllByRole('checkbox', { name: /^Show \// })
      .map((c) => c.getAttribute('aria-label'));
    expect(shown).toEqual([
      'Show /private/tmp/brain-probe',
      'Show /Users/greg/Repos/personal/WIN',
    ]);
  });

  it('sorts the project column by path', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^project/i }));
    // Descending on the first click, so `/Users…` leads `/private…`.
    expect(itemCells()).toEqual(['aaa', 'bbb', 'ccc']);
    fireEvent.click(screen.getByRole('button', { name: /^project/i }));
    expect(itemCells()).toEqual(['ccc', 'aaa', 'bbb']);
  });

  /**
   * Comparing paths as flat text lets a sibling land in the middle of a
   * folder's subtree, which is what made the list read as unsorted. Segment-
   * wise, `a` beats `a-x` at the segment that differs, so `/a`'s children stay
   * contiguous and its parent leads them.
   */
  it('keeps a folder subtree contiguous, parent first', () => {
    expect(
      ['/a/b/z', '/a-x', '/a/b', '/a/b/c'].sort(comparePaths),
    ).toEqual(['/a/b', '/a/b/c', '/a/b/z', '/a-x']);
  });

  it('is case-insensitive, so Repos and repos do not split the list', () => {
    expect(['/x/Zed', '/x/apple'].sort(comparePaths)).toEqual(['/x/apple', '/x/Zed']);
  });
});
