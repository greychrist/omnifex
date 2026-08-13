// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainSourcesTable, comparePaths, rowId } from '@/components/brain/BrainSourcesTable';
import type { BrainSourceSummary } from '@/lib/api';

function row(over: Partial<BrainSourceSummary> = {}): BrainSourceSummary {
  // `name` follows the item key unless a fixture sets it, mirroring the
  // backend rule for sessions — otherwise a row overriding only `itemKey`
  // would render under a name no real listing would ever produce.
  const base: BrainSourceSummary = {
    accountId: 1,
    sourceId: 'session',
    itemKey: 'sess-a',
    name: 'sess-a',
    inUse: false,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
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
  return { ...base, name: over.name ?? base.itemKey };
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
      .map((r) => within(r).getAllByRole('cell')[3].textContent ?? '');
    expect(types).toEqual(['Session', 'Memory', 'Repo file']);
  });

  // Supersedes an earlier "does not show the session id" rule. Hiding it made
  // every row anonymous: the project column is shared by dozens of rows, so
  // nothing on screen said WHICH conversation a row was.
  it('shows each row identity under a Name column', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /^Name/ })).toBeTruthy();
    expect(screen.getByText('aaa')).toBeTruthy();
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

  /**
   * Re-indexing an unchanged item is a no-op the service already refuses
   * ("unchanged since it was last indexed"), so offering it as a choice
   * invites a press that spends nothing and does nothing.
   */
  it('cannot select a row that is indexed and unchanged', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Select ccc')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Select aaa')).toHaveProperty('disabled', false);
  });

  it('still allows a row that changed since it was indexed', () => {
    render(<Harness rows={[row({ itemKey: 'moved', status: 'indexed', changed: true })]} />);
    expect(screen.getByLabelText('Select moved')).toHaveProperty('disabled', false);
  });

  it('select-all skips the rows that cannot be selected', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/select all shown/i));
    // Three rows shown, but `ccc` is indexed and unchanged.
    expect(screen.getByTestId('count').textContent).toBe('2');
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
    render(<Harness rows={[ROWS[0], ROWS[1], row({ itemKey: 'other', label: '/tmp/x' })]} />);
    fireEvent.click(screen.getByLabelText(/filter by project/i));
    fireEvent.click(screen.getByLabelText('Show /tmp/x'));
    fireEvent.click(screen.getByLabelText(/select all shown/i));
    // Two shown, and the hidden project's row is not reached.
    expect(screen.getByTestId('count').textContent).toBe('2');
  });

  it('select-all toggles off when everything shown is already selected', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/select all shown/i));
    expect(screen.getByTestId('count').textContent).toBe('2');
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

// A row's identity was searchable but invisible: you could paste a session id
// into the filter and find it, but nothing on screen told you which row was
// which conversation. The Name column puts that back — the session id for a
// session, the file name for anything file-backed.
describe('BrainSourcesTable — Name column', () => {
  it('shows the backend-computed name for each row', () => {
    render(
      <BrainSourcesTable
        rows={[
          row({ itemKey: 'sess-1', name: 'sess-1' }),
          row({ itemKey: '-Users-greg-x:notes.md', sourceId: 'auto-memory', name: 'notes.md' }),
        ]}
        selected={new Set()}
        onSelectedChange={vi.fn()}
        activeItemKey={null}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText('sess-1')).toBeTruthy();
    expect(screen.getByText('notes.md')).toBeTruthy();
    // The encoded key is never what the user reads.
    expect(screen.queryByText('-Users-greg-x:notes.md')).toBeNull();
  });

  it('sorts by name', () => {
    render(
      <BrainSourcesTable
        rows={[row({ itemKey: 'b', name: 'zeta.md' }), row({ itemKey: 'a', name: 'alpha.md' })]}
        selected={new Set()}
        onSelectedChange={vi.fn()}
        activeItemKey={null}
        onOpen={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Name/ }));
    const names = screen.getAllByTestId('source-name').map((el) => el.textContent);
    expect(names).toEqual(['zeta.md', 'alpha.md']);
    fireEvent.click(screen.getByRole('button', { name: /^Name/ }));
    expect(screen.getAllByTestId('source-name').map((el) => el.textContent))
      .toEqual(['alpha.md', 'zeta.md']);
  });
});

// A session that is open is still being written to. Indexing it distils half a
// conversation and records it as done — which is exactly what happened to
// session 82ab1eb8 on 2026-08-13.
describe('BrainSourcesTable — sessions in use', () => {
  it('marks an in-use row and refuses to let it be ticked', () => {
    render(
      <BrainSourcesTable
        rows={[row({ itemKey: 'live', name: 'live', inUse: true })]}
        selected={new Set()}
        onSelectedChange={vi.fn()}
        activeItemKey={null}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(/in use/i)).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: /Select live/ }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });

  it('leaves an in-use row out of select-all', () => {
    const onSelectedChange = vi.fn();
    render(
      <BrainSourcesTable
        rows={[
          row({ itemKey: 'live', name: 'live', inUse: true }),
          row({ itemKey: 'done', name: 'done' }),
        ]}
        selected={new Set()}
        onSelectedChange={onSelectedChange}
        activeItemKey={null}
        onOpen={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /select all shown/i }));
    const next = onSelectedChange.mock.calls[0][0] as Set<string>;
    expect([...next]).toEqual(['session:done']);
  });

  it('still lets an in-use row be opened for preview', () => {
    // Reading a live session is free and useful; only spending on it is not.
    const onOpen = vi.fn();
    render(
      <BrainSourcesTable
        rows={[row({ itemKey: 'live', name: 'live', inUse: true })]}
        selected={new Set()}
        onSelectedChange={vi.fn()}
        activeItemKey={null}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByText('live'));
    expect(onOpen).toHaveBeenCalledWith('live');
  });
});

// Every indexing run's cost comes back in the CLI's own JSON envelope; the
// runner used to discard it. Now that it is recorded, the row that was paid
// for is where it belongs.
describe('BrainSourcesTable — cost', () => {
  it('shows what a row cost, and nothing for one never indexed', () => {
    render(
      <BrainSourcesTable
        rows={[
          row({ itemKey: 'paid', name: 'paid', costUsd: 0.020333 }),
          row({ itemKey: 'free', name: 'free' }),
        ]}
        selected={new Set()}
        onSelectedChange={vi.fn()}
        activeItemKey={null}
        onOpen={vi.fn()}
      />,
    );
    const cells = screen.getAllByTestId('source-cost').map((c) => c.textContent);
    // Sub-cent runs still have to read as money, not as "$0.02" rounded from
    // nothing — and an unindexed row must not claim to have been free.
    expect(cells).toEqual(['$0.0203', '—']);
  });

  it('breaks the cost down by tokens on hover', () => {
    render(
      <BrainSourcesTable
        rows={[row({
          itemKey: 'paid', name: 'paid', costUsd: 0.02,
          inputTokens: 10, outputTokens: 315,
          cacheReadTokens: 0, cacheCreationTokens: 9374,
        })]}
        selected={new Set()}
        onSelectedChange={vi.fn()}
        activeItemKey={null}
        onOpen={vi.fn()}
      />,
    );
    const title = screen.getByTestId('source-cost').getAttribute('title') ?? '';
    expect(title).toMatch(/10 in/);
    expect(title).toMatch(/315 out/);
    expect(title).toMatch(/9,374 cache write/);
  });

  it('sorts by cost, with never-indexed rows treated as zero', () => {
    render(
      <BrainSourcesTable
        rows={[
          row({ itemKey: 'a', name: 'a', costUsd: 0.01 }),
          row({ itemKey: 'b', name: 'b', costUsd: 0.5 }),
          row({ itemKey: 'c', name: 'c' }),
        ]}
        selected={new Set()}
        onSelectedChange={vi.fn()}
        activeItemKey={null}
        onOpen={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Cost/ }));
    expect(screen.getAllByTestId('source-name').map((n) => n.textContent))
      .toEqual(['b', 'a', 'c']);
  });
});
