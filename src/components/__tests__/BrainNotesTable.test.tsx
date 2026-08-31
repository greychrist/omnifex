// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainNotesTable } from '@/components/brain/BrainNotesTable';
import { api, type BrainNoteMeta } from '@/lib/api';

vi.mock('@/lib/api', () => ({ api: { brainSearch: vi.fn() } }));

function note(over: Partial<BrainNoteMeta> = {}): BrainNoteMeta {
  return {
    relPath: 'Subsystems/a.md',
    title: 'a',
    type: 'Subsystem',
    project: 'WIN',
    created: '2026-08-01',
    updated: '2026-08-01',
    curatedAt: null,
    ...over,
  };
}

const NOTES = [
  note({ relPath: 'Subsystems/alpha.md', title: 'alpha', project: 'WIN', updated: '2026-08-10' }),
  note({
    relPath: 'Topics/beta.md',
    title: 'beta',
    type: 'Topic',
    project: 'omnifex',
    updated: '2026-08-20',
    curatedAt: '2026-08-25',
  }),
  note({
    relPath: 'Notes/gamma.md',
    title: 'gamma',
    type: 'Note',
    project: null,
    updated: '2026-08-05',
  }),
];

/** Every row's title, in the order the table renders them. */
function titles(): string[] {
  return screen.getAllByTestId('note-title').map((n) => n.textContent ?? '');
}

function renderTable(over: Partial<React.ComponentProps<typeof BrainNotesTable>> = {}) {
  const onSelect = vi.fn();
  render(
    <BrainNotesTable
      accountId={1}
      notes={NOTES}
      selected={null}
      onSelect={onSelect}
      {...over}
    />,
  );
  return { onSelect };
}

describe('BrainNotesTable', () => {
  beforeEach(() => { vi.mocked(api.brainSearch).mockReset().mockResolvedValue([]); });
  afterEach(() => { cleanup(); });

  /**
   * Newest first with no interaction. A vault is a growing pile and the note
   * you want is almost always one you touched recently; alphabetical would put
   * that answer wherever the alphabet happened to leave it.
   */
  it('opens sorted by most recently updated', () => {
    renderTable();
    expect(titles()).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('shows each note type and project', () => {
    renderTable();
    expect(screen.getAllByTestId('note-type').map((n) => n.textContent))
      .toEqual(['Topic', 'Subsystem', 'Note']);
    expect(screen.getAllByTestId('note-project').map((n) => n.textContent))
      .toEqual(['omnifex', 'WIN', '—']);
  });

  /**
   * 20 of 338 notes carry a curation date, so it is a dimmed second line under
   * Updated rather than a column that would be empty for 94% of rows.
   */
  it('shows a curation date beneath the updated date when there is one', () => {
    renderTable();
    const curated = screen.getAllByTestId('note-curated').map((n) => n.textContent);
    expect(curated).toEqual(['curated 2026-08-25', '', '']);
  });

  it('sorts by project, and reverses on a second press', () => {
    renderTable();
    const header = screen.getByRole('button', { name: /^project/i });
    fireEvent.click(header);
    // Descending first, matching the Sources table. Unowned notes sort last
    // in either direction — an absence is not a name.
    expect(titles()).toEqual(['alpha', 'beta', 'gamma']);
    fireEvent.click(header);
    expect(titles()).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('sorts by updated date in both directions', () => {
    renderTable();
    const header = screen.getByRole('button', { name: /^updated/i });
    // Already the default, so the first press flips it to oldest first.
    fireEvent.click(header);
    expect(titles()).toEqual(['gamma', 'alpha', 'beta']);
    fireEvent.click(header);
    expect(titles()).toEqual(['beta', 'alpha', 'gamma']);
  });

  /** Descending on the first press, uniformly across every column, so the
   *  arrow means the same thing here as it does in the Sources table. */
  it('sorts by name', () => {
    renderTable();
    const header = screen.getByRole('button', { name: /^name/i });
    fireEvent.click(header);
    expect(titles()).toEqual(['gamma', 'beta', 'alpha']);
    fireEvent.click(header);
    expect(titles()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('filters by project from the popover', () => {
    renderTable();
    fireEvent.click(screen.getByLabelText(/filter by project/i));
    fireEvent.click(screen.getByLabelText('Show WIN'));
    expect(titles()).toEqual(['beta', 'gamma']);
  });

  /**
   * Notes with no project are a real population — 7 of 338 in the live vault.
   * Leaving them out of the picker would make them unhideable and invisible in
   * the count, so they get their own bucket.
   */
  it('offers unowned notes as their own filter bucket', () => {
    renderTable();
    fireEvent.click(screen.getByLabelText(/filter by project/i));
    fireEvent.click(screen.getByLabelText('Show (no project)'));
    expect(titles()).toEqual(['beta', 'alpha']);
  });

  it('reports how many projects are showing once some are hidden', () => {
    renderTable();
    const trigger = screen.getByLabelText(/filter by project/i);
    expect(trigger.textContent).toBe('All projects');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByLabelText('Show WIN'));
    expect(trigger.textContent).toBe('2 of 3 projects');
  });

  it('opens the note that was clicked', () => {
    const { onSelect } = renderTable();
    fireEvent.click(screen.getByText('alpha'));
    expect(onSelect).toHaveBeenCalledWith('Subsystems/alpha.md');
  });

  it('marks the open note as selected', () => {
    renderTable({ selected: 'Topics/beta.md' });
    const selected = screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('beta');
  });

  /**
   * Full-text search narrows the same table rather than replacing it with a
   * second list. Two lists with two layouts was the old pane's shape, and
   * which one you were looking at was not always obvious.
   */
  it('narrows the rows to full-text hits, ranked', async () => {
    vi.mocked(api.brainSearch).mockResolvedValue([
      { notePath: 'Notes/gamma.md', title: 'gamma', snippet: 'the stdio bridge', type: 'Note' },
      { notePath: 'Subsystems/alpha.md', title: 'alpha', snippet: 'a match', type: 'Subsystem' },
    ] as never);
    renderTable();
    fireEvent.change(screen.getByLabelText(/search this vault/i), { target: { value: 'stdio' } });
    await waitFor(() => { expect(titles()).toEqual(['gamma', 'alpha']); });
    expect(screen.getByText('the stdio bridge')).toBeTruthy();
  });

  it('says a search failed rather than showing an empty vault', async () => {
    vi.mocked(api.brainSearch).mockRejectedValue(new Error('index is corrupt'));
    renderTable();
    fireEvent.change(screen.getByLabelText(/search this vault/i), { target: { value: 'stdio' } });
    await waitFor(() => { expect(screen.getByText('index is corrupt')).toBeTruthy(); });
  });

  it('tells the user when a vault has no notes at all', () => {
    renderTable({ notes: [] });
    expect(screen.getByText(/no notes in this vault yet/i)).toBeTruthy();
  });

  it('distinguishes a filter that matches nothing from an empty vault', () => {
    renderTable();
    fireEvent.click(screen.getByLabelText(/filter by project/i));
    fireEvent.click(screen.getByRole('button', { name: /hide all/i }));
    expect(screen.getByText(/nothing matches/i)).toBeTruthy();
  });
});
