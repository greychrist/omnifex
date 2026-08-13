// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainSourcesTable, rowId } from '@/components/brain/BrainSourcesTable';
import type { BrainSourceSummary } from '@/lib/api';

function row(over: Partial<BrainSourceSummary> = {}): BrainSourceSummary {
  return {
    accountId: 1,
    sourceId: 'session',
    itemKey: 'sess-a',
    label: '-Users-greg-Repos-personal-WIN',
    labelPath: '/Users/greg/Repos/personal/WIN',
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
    label: '-private-tmp-brain-probe',
    labelPath: '/private/tmp/brain-probe',
    mtimeMs: Date.parse('2026-08-05T00:00:00Z'),
    size: 5_000,
    status: 'indexed',
    changed: false,
  }),
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

function itemCells(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[2].textContent ?? '');
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

  it('filters on free text across session and project', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText(/filter sessions/i), { target: { value: 'ccc' } });
    expect(itemCells()).toEqual(['ccc']);

    fireEvent.change(screen.getByLabelText(/filter sessions/i), { target: { value: 'tmp' } });
    expect(itemCells()).toEqual(['ccc']);
  });

  it('filters by project', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText(/filter by project/i), {
      target: { value: '-private-tmp-brain-probe' },
    });
    expect(itemCells()).toEqual(['ccc']);
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
    fireEvent.change(screen.getByLabelText(/filter by project/i), {
      target: { value: '-private-tmp-brain-probe' },
    });
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

  it('shows the folder path, not the encoded directory name', () => {
    render(<Harness />);
    const cells = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[1].textContent ?? '');
    expect(cells).toContain('/Users/greg/Repos/personal/WIN');
    expect(cells).toContain('/private/tmp/brain-probe');
  });

  /**
   * Alphabetical on the PATH, which is what the user reads. Sorting the
   * encoded names instead would order `-private-...` before `-Users-...` on
   * the strength of characters nobody is looking at.
   */
  it('lists projects alphabetically by path in the filter', () => {
    render(<Harness />);
    const options = within(screen.getByLabelText(/filter by project/i))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'All projects',
      '/private/tmp/brain-probe',
      '/Users/greg/Repos/personal/WIN',
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
});
