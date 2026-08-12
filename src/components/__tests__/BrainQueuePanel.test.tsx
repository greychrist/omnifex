// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BrainQueuePanel } from '@/components/brain/BrainQueuePanel';
import { api, type BrainQueueEntry } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    brainQueueCounts: vi.fn(),
    brainQueueList: vi.fn(),
    brainBackfill: vi.fn(),
    brainQueueDrain: vi.fn(),
    brainQueueClear: vi.fn(),
  },
}));

function entry(over: Partial<BrainQueueEntry> = {}): BrainQueueEntry {
  return {
    id: 1, accountId: 1, sourceId: 'session', itemKey: 'sess-a',
    status: 'pending', error: null,
    enqueuedAt: '2026-08-12T10:00:00Z', startedAt: null, finishedAt: null,
    ...over,
  };
}

describe('BrainQueuePanel', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainQueueCounts).mockResolvedValue({
      pending: 0, running: 0, done: 0, failed: 0,
    });
    vi.mocked(api.brainQueueList).mockResolvedValue([]);
    vi.mocked(api.brainBackfill).mockResolvedValue(0);
    vi.mocked(api.brainQueueDrain).mockResolvedValue(undefined);
    vi.mocked(api.brainQueueClear).mockResolvedValue(undefined);
  });

  it('shows queue depth for the selected account', async () => {
    vi.mocked(api.brainQueueCounts).mockResolvedValue({
      pending: 7, running: 1, done: 12, failed: 2,
    });
    render(<BrainQueuePanel accountId={1} />);

    expect(await screen.findByText(/7 pending/i)).toBeTruthy();
    expect(screen.getByText(/2 failed/i)).toBeTruthy();
    expect(api.brainQueueCounts).toHaveBeenCalledWith(1);
  });

  it('shows a failed item with its error', async () => {
    vi.mocked(api.brainQueueCounts).mockResolvedValue({
      pending: 0, running: 0, done: 0, failed: 1,
    });
    vi.mocked(api.brainQueueList).mockResolvedValue([
      entry({ status: 'failed', error: 'extraction failed validation at entities.0.type' }),
    ]);
    render(<BrainQueuePanel accountId={1} />);

    // Spec §14: failed items with their validation errors. Without the error
    // text the pane says something broke but not what, which is useless.
    expect(await screen.findByText(/entities\.0\.type/)).toBeTruthy();
  });

  it('backfills and refreshes the counts', async () => {
    vi.mocked(api.brainBackfill).mockResolvedValue(14);
    render(<BrainQueuePanel accountId={1} />);
    await screen.findByText(/0 pending/i);

    fireEvent.click(screen.getByRole('button', { name: /backfill/i }));

    await waitFor(() => { expect(api.brainBackfill).toHaveBeenCalledWith(1); });
    expect(await screen.findByText(/queued 14/i)).toBeTruthy();
    await waitFor(() => { expect(api.brainQueueCounts).toHaveBeenCalledTimes(2); });
  });

  it('drains on demand', async () => {
    render(<BrainQueuePanel accountId={1} />);
    await screen.findByText(/0 pending/i);

    fireEvent.click(screen.getByRole('button', { name: /drain/i }));

    await waitFor(() => { expect(api.brainQueueDrain).toHaveBeenCalled(); });
  });

  it('clears finished entries', async () => {
    render(<BrainQueuePanel accountId={1} />);
    await screen.findByText(/0 pending/i);

    fireEvent.click(screen.getByRole('button', { name: /clear finished/i }));

    await waitFor(() => { expect(api.brainQueueClear).toHaveBeenCalledWith(1); });
  });

  it('surfaces a backfill failure rather than silently doing nothing', async () => {
    vi.mocked(api.brainBackfill).mockRejectedValue(new Error('no vault configured'));
    render(<BrainQueuePanel accountId={1} />);
    await screen.findByText(/0 pending/i);

    fireEvent.click(screen.getByRole('button', { name: /backfill/i }));

    expect(await screen.findByText(/no vault configured/)).toBeTruthy();
  });

  it('asks for nothing when no account is selected', () => {
    render(<BrainQueuePanel accountId={null} />);
    expect(api.brainQueueCounts).not.toHaveBeenCalled();
  });

  it('re-reads when the account changes', async () => {
    const { rerender } = render(<BrainQueuePanel accountId={1} />);
    await waitFor(() => { expect(api.brainQueueCounts).toHaveBeenCalledWith(1); });

    rerender(<BrainQueuePanel accountId={2} />);

    // Queue depth is per account; showing one account's backlog under another
    // would misreport what is about to be indexed and where.
    await waitFor(() => { expect(api.brainQueueCounts).toHaveBeenCalledWith(2); });
  });
});
