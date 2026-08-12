// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { RecallDialog } from '../brain/RecallDialog';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    brainSearch: vi.fn(),
    brainReadNote: vi.fn(),
  },
}));

const HIT = {
  notePath: 'Subsystems/Queue.md',
  type: 'Subsystem',
  title: 'Queue',
  snippet: 'the [drain] worker',
  score: -1,
};

describe('RecallDialog', () => {
  beforeEach(() => {
    vi.mocked(api.brainSearch).mockResolvedValue([HIT]);
    vi.mocked(api.brainReadNote).mockResolvedValue({
      frontmatter: {
        type: 'Subsystem', aliases: [], keywords: [],
        created: '2026-08-12', updated: '2026-08-12', sources: [],
      },
      body: 'the drain worker yields to sessions',
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function open(onInsert = vi.fn()) {
    render(
      <RecallDialog open accountId={7} onOpenChange={vi.fn()} onInsert={onInsert} />,
    );
    return onInsert;
  }

  async function search(term = 'drain') {
    fireEvent.change(screen.getByLabelText('Search the Brain'), { target: { value: term } });
    fireEvent.submit(screen.getByLabelText('Search the Brain').closest('form')!);
    await screen.findByText('Queue');
  }

  it('searches only the account it was given', async () => {
    open();
    await search();
    // Never merged across vaults: a search shows one account's hits, and
    // switching vaults is a deliberate act elsewhere in the app.
    expect(api.brainSearch).toHaveBeenCalledWith(7, 'drain');
  });

  it('inserts the full body of the selected note under its path', async () => {
    const onInsert = open();
    await search();

    fireEvent.click(screen.getByText('Queue'));
    fireEvent.click(screen.getByRole('button', { name: /insert 1 note/i }));

    await waitFor(() => { expect(onInsert).toHaveBeenCalled(); });
    expect(api.brainReadNote).toHaveBeenCalledWith(7, 'Subsystems/Queue.md');
    expect(onInsert.mock.calls[0][0]).toBe(
      '<recalled-notes>\n### Subsystems/Queue.md\n\nthe drain worker yields to sessions\n</recalled-notes>\n\n',
    );
  });

  it('cannot insert with nothing selected', async () => {
    open();
    await search();
    expect(screen.getByRole('button', { name: /insert 0 notes/i }).hasAttribute('disabled')).toBe(true);
  });

  it('surfaces a search failure instead of showing an empty vault', async () => {
    vi.mocked(api.brainSearch).mockRejectedValue(new Error('index unavailable'));
    open();
    fireEvent.change(screen.getByLabelText('Search the Brain'), { target: { value: 'drain' } });
    fireEvent.submit(screen.getByLabelText('Search the Brain').closest('form')!);

    expect(await screen.findByText('index unavailable')).toBeTruthy();
  });

  it('keeps the dialog open when a selected note cannot be read', async () => {
    vi.mocked(api.brainReadNote).mockRejectedValue(new Error('cannot read note: bad frontmatter'));
    const onInsert = open();
    await search();

    fireEvent.click(screen.getByText('Queue'));
    fireEvent.click(screen.getByRole('button', { name: /insert 1 note/i }));

    // Closing on a failed read would look like a successful insert.
    expect(await screen.findByText(/cannot read note/)).toBeTruthy();
    expect(onInsert).not.toHaveBeenCalled();
  });
});
