// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BrainNoteList } from '@/components/brain/BrainNoteList';
import { api, type BrainSearchHit } from '@/lib/api';

vi.mock('@/lib/api', () => ({ api: { brainSearch: vi.fn() } }));

const notes = ['Projects/omnifex.md', 'Subsystems/Sessions.md', 'Subsystems/Brain.md'];

function hit(over: Partial<BrainSearchHit> = {}): BrainSearchHit {
  return {
    notePath: 'Subsystems/Sessions.md', type: 'Subsystem', title: 'Sessions',
    snippet: 'the [pty] layer', score: -3, ...over,
  };
}

async function typeQuery(value: string): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value } });
}

describe('BrainNoteList', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainSearch).mockResolvedValue([]);
  });

  it('groups notes by folder', () => {
    render(<BrainNoteList accountId={1} notes={notes} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.getByText('Subsystems')).toBeTruthy();
  });

  it('sorts alphabetically within a folder', () => {
    render(<BrainNoteList accountId={1} notes={notes} selected={null} onSelect={vi.fn()} />);
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels.indexOf('Brain')).toBeLessThan(labels.indexOf('Sessions'));
  });

  it('selects a note on click', () => {
    const onSelect = vi.fn();
    render(<BrainNoteList accountId={1} notes={notes} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'omnifex' }));
    expect(onSelect).toHaveBeenCalledWith('Projects/omnifex.md');
  });

  it('replaces the grouped list with ranked hits when searching', async () => {
    vi.mocked(api.brainSearch).mockResolvedValue([hit()]);
    render(<BrainNoteList accountId={1} notes={notes} selected={null} onSelect={vi.fn()} />);

    await typeQuery('pty');
    await waitFor(() => { expect(screen.getByText(/the/)).toBeTruthy(); });
    // Grouping headers belong to browse mode only. A merged view would show
    // both, and rank would stop meaning anything.
    expect(screen.queryByText('Projects')).toBeNull();
  });

  it('searches the selected account only', async () => {
    render(<BrainNoteList accountId={7} notes={notes} selected={null} onSelect={vi.fn()} />);
    await typeQuery('pty');
    await waitFor(() => { expect(api.brainSearch).toHaveBeenCalled(); });
    expect(vi.mocked(api.brainSearch).mock.calls[0][0]).toBe(7);
  });

  it('returns to the grouped list when the query is cleared', async () => {
    render(<BrainNoteList accountId={1} notes={notes} selected={null} onSelect={vi.fn()} />);
    await typeQuery('pty');
    await waitFor(() => { expect(api.brainSearch).toHaveBeenCalled(); });

    await typeQuery('');
    await waitFor(() => { expect(screen.getByText('Projects')).toBeTruthy(); });
  });

  it('selects a search hit on click', async () => {
    const onSelect = vi.fn();
    vi.mocked(api.brainSearch).mockResolvedValue([hit()]);
    render(<BrainNoteList accountId={1} notes={notes} selected={null} onSelect={onSelect} />);

    await typeQuery('pty');
    await waitFor(() => { expect(screen.getByRole('button', { name: /Sessions/ })).toBeTruthy(); });
    fireEvent.click(screen.getByRole('button', { name: /Sessions/ }));
    expect(onSelect).toHaveBeenCalledWith('Subsystems/Sessions.md');
  });

  it('says so when a search finds nothing', async () => {
    render(<BrainNoteList accountId={1} notes={notes} selected={null} onSelect={vi.fn()} />);
    await typeQuery('nothingmatches');
    await waitFor(() => { expect(screen.getByText(/no matches/i)).toBeTruthy(); });
  });

  it('says so when a vault has no notes', () => {
    render(<BrainNoteList accountId={1} notes={[]} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/no notes/i)).toBeTruthy();
  });

  it('does not search without an account', async () => {
    render(<BrainNoteList accountId={null} notes={notes} selected={null} onSelect={vi.fn()} />);
    await typeQuery('pty');
    await new Promise((r) => setTimeout(r, 350));
    expect(api.brainSearch).not.toHaveBeenCalled();
  });

  it('surfaces a search failure instead of showing an empty result', async () => {
    vi.mocked(api.brainSearch).mockRejectedValue(new Error('index corrupt'));
    render(<BrainNoteList accountId={1} notes={notes} selected={null} onSelect={vi.fn()} />);

    await typeQuery('pty');
    await waitFor(() => { expect(screen.getByText(/index corrupt/)).toBeTruthy(); });
  });

  it('discards a slow response for a stale query', async () => {
    let resolveSlow: (v: BrainSearchHit[]) => void = () => {};
    vi.mocked(api.brainSearch)
      .mockImplementationOnce(() => new Promise<BrainSearchHit[]>((r) => { resolveSlow = r; }))
      .mockResolvedValue([hit({ notePath: 'Subsystems/Brain.md', title: 'Brain' })]);

    render(<BrainNoteList accountId={1} notes={notes} selected={null} onSelect={vi.fn()} />);
    await typeQuery('pty');
    await waitFor(() => { expect(api.brainSearch).toHaveBeenCalledTimes(1); });
    await typeQuery('brain');
    await waitFor(() => { expect(screen.getByRole('button', { name: /Brain/ })).toBeTruthy(); });

    // The first query's answer lands late; it must not replace the second's.
    resolveSlow([hit({ title: 'Sessions' })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /Sessions/ })).toBeNull();
  });
});
