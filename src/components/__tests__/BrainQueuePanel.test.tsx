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
    brainEnqueueCuration: vi.fn(),
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
    brainMcpStatus: vi.fn(),
    brainMcpRegister: vi.fn(),
    brainMcpUnregister: vi.fn(),
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

/**
 * These pin the failure that prompted the operational pane: the user selected
 * one session, pressed "Drain now", and the worker began indexing all 158
 * queued items with no progress and an unconditional success message.
 */
describe('BrainQueuePanel controls', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainQueueCounts).mockResolvedValue({
      pending: 154, running: 0, done: 4, failed: 0,
    });
    vi.mocked(api.brainQueueList).mockResolvedValue([]);
    vi.mocked(api.brainBackfill).mockResolvedValue(0);
    vi.mocked(api.brainQueueDrain).mockResolvedValue({
      processed: 0, yielded: false, reason: 'empty',
    });
    vi.mocked(api.brainQueueClear).mockResolvedValue(undefined);
    vi.mocked(api.getSetting).mockResolvedValue('false');
    vi.mocked(api.saveSetting).mockResolvedValue(undefined);
    vi.mocked(api.brainMcpStatus).mockResolvedValue({ registered: false, available: false });
    vi.mocked(api.brainEnqueueCuration).mockResolvedValue(0);
  });

  it('labels the bulk action with the pending count', async () => {
    render(<BrainQueuePanel accountId={1} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /index all \(154\)/i })).toBeTruthy();
    });
    // "Drain" describes the queue's internals, not what the user is doing.
    expect(screen.queryByRole('button', { name: /drain/i })).toBeNull();
  });

  it('does not start a bulk run on the first click', async () => {
    render(<BrainQueuePanel accountId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: /index all \(154\)/i }));
    expect(api.brainQueueDrain).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /confirm/i })).toBeTruthy();
  });

  it('starts the bulk run only after confirmation', async () => {
    render(<BrainQueuePanel accountId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: /index all \(154\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => { expect(api.brainQueueDrain).toHaveBeenCalledTimes(1); });
  });

  it('says it yielded rather than claiming a run finished', async () => {
    vi.mocked(api.brainQueueDrain).mockResolvedValue({
      processed: 0, yielded: true, reason: 'session-active',
    });
    render(<BrainQueuePanel accountId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: /index all \(154\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => { expect(screen.getByText(/yielded/i)).toBeTruthy(); });
    expect(screen.getByText(/session is open/i)).toBeTruthy();
    // It must not claim to have indexed anything. (Not a bare /finished/i
    // check — the "Clear finished" button matches that.)
    expect(screen.queryByText(/^indexed \d/i)).toBeNull();
  });

  it('reports what a completed run actually indexed', async () => {
    vi.mocked(api.brainQueueDrain).mockResolvedValue({
      processed: 12, yielded: false, reason: 'empty',
    });
    render(<BrainQueuePanel accountId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: /index all \(154\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => { expect(screen.getByText(/indexed 12/i)).toBeTruthy(); });
  });

  it('offers Resume, not Pause, when the queue is already paused', async () => {
    vi.mocked(api.getSetting).mockImplementation((k: string) =>
      Promise.resolve(k === 'brain.queuePaused' ? 'true' : 'false'));
    render(<BrainQueuePanel accountId={1} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^resume$/i })).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /^pause$/i })).toBeNull();
  });

  it('flips Pause to Resume when pressed', async () => {
    render(<BrainQueuePanel accountId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: /^pause$/i }));
    expect(api.saveSetting).toHaveBeenCalledWith('brain.queuePaused', 'true');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^resume$/i })).toBeTruthy();
    });
  });

  /**
   * The stale-read bug this tab has now shipped three times. A pause applied
   * from anywhere other than this button must show up here.
   */
  it('re-reads settings after an action rather than only at mount', async () => {
    render(<BrainQueuePanel accountId={1} />);
    await screen.findByRole('button', { name: /^pause$/i });

    vi.mocked(api.getSetting).mockImplementation((k: string) =>
      Promise.resolve(k === 'brain.queuePaused' ? 'true' : 'false'));
    fireEvent.click(screen.getByRole('button', { name: /clear finished/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^resume$/i })).toBeTruthy();
    });
  });
});

describe('BrainQueuePanel', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainQueueCounts).mockResolvedValue({
      pending: 0, running: 0, done: 0, failed: 0,
    });
    vi.mocked(api.brainQueueList).mockResolvedValue([]);
    vi.mocked(api.brainBackfill).mockResolvedValue(0);
    vi.mocked(api.brainQueueDrain).mockResolvedValue({
      processed: 0, yielded: false, reason: 'empty',
    });
    vi.mocked(api.brainQueueClear).mockResolvedValue(undefined);
    vi.mocked(api.getSetting).mockResolvedValue('false');
    vi.mocked(api.saveSetting).mockResolvedValue(undefined);
    vi.mocked(api.brainMcpStatus).mockResolvedValue({ registered: false, available: true });
    vi.mocked(api.brainMcpRegister).mockResolvedValue(undefined);
    vi.mocked(api.brainMcpUnregister).mockResolvedValue(undefined);
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

  it('drains on demand, behind the confirmation', async () => {
    vi.mocked(api.brainQueueCounts).mockResolvedValue({
      pending: 3, running: 0, done: 0, failed: 0,
    });
    render(<BrainQueuePanel accountId={1} />);

    fireEvent.click(await screen.findByRole('button', { name: /index all \(3\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => { expect(api.brainQueueDrain).toHaveBeenCalled(); });
  });

  it('cannot start a bulk run with nothing pending', async () => {
    render(<BrainQueuePanel accountId={1} />);
    const btn = await screen.findByRole('button', { name: /index all \(0\)/i });
    expect(btn).toHaveProperty('disabled', true);
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

  it('reflects that auto-indexing is off by default', async () => {
    render(<BrainQueuePanel accountId={1} />);
    const toggle = await screen.findByRole('checkbox', { name: /auto-index/i });
    // Off by default: it spends tokens unattended, so the user opts in.
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it('turns auto-indexing on and persists it', async () => {
    render(<BrainQueuePanel accountId={1} />);
    const toggle = await screen.findByRole('checkbox', { name: /auto-index/i });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(api.saveSetting).toHaveBeenCalledWith('brain.autoIndex', 'true');
    });
  });

  it('reflects auto-indexing already on', async () => {
    vi.mocked(api.getSetting).mockImplementation(async (key: string) =>
      key === 'brain.autoIndex' ? 'true' : 'false');
    render(<BrainQueuePanel accountId={1} />);
    const toggle = await screen.findByRole('checkbox', { name: /auto-index/i });
    await waitFor(() => { expect((toggle as HTMLInputElement).checked).toBe(true); });
  });

  it('pauses the queue', async () => {
    render(<BrainQueuePanel accountId={1} />);
    const pause = await screen.findByRole('button', { name: /^pause$/i });

    fireEvent.click(pause);

    await waitFor(() => {
      expect(api.saveSetting).toHaveBeenCalledWith('brain.queuePaused', 'true');
    });
  });

  it('reads both switches once, not per account change', async () => {
    const { rerender } = render(<BrainQueuePanel accountId={1} />);
    await screen.findByRole('checkbox', { name: /auto-index/i });
    const before = vi.mocked(api.getSetting).mock.calls.length;

    rerender(<BrainQueuePanel accountId={2} />);
    await waitFor(() => { expect(api.brainQueueCounts).toHaveBeenCalledWith(2); });

    // Both switches are GLOBAL, not per account — re-reading them on every
    // account switch would imply they are scoped when they are not.
    expect(vi.mocked(api.getSetting).mock.calls.length).toBe(before);
  });

  describe('expose to Claude outside OmniFex', () => {
    const toggle = () => screen.getByLabelText(/outside omnifex/i);

    it('offers the toggle only for an account with a vault', async () => {
      vi.mocked(api.brainMcpStatus).mockResolvedValue({ registered: false, available: false });
      render(<BrainQueuePanel accountId={1} />);
      await waitFor(() => { expect(api.brainMcpStatus).toHaveBeenCalledWith(1); });
      expect(screen.queryByLabelText(/outside omnifex/i)).toBeNull();
    });

    it('registers this account when switched on', async () => {
      render(<BrainQueuePanel accountId={1} />);
      await waitFor(() => { expect(toggle()).toBeTruthy(); });

      fireEvent.click(toggle());

      await waitFor(() => { expect(api.brainMcpRegister).toHaveBeenCalledWith(1); });
      expect(api.brainMcpUnregister).not.toHaveBeenCalled();
    });

    it('unregisters when switched off', async () => {
      vi.mocked(api.brainMcpStatus).mockResolvedValue({ registered: true, available: true });
      render(<BrainQueuePanel accountId={1} />);
      await waitFor(() => { expect((toggle() as HTMLInputElement).checked).toBe(true); });

      fireEvent.click(toggle());

      await waitFor(() => { expect(api.brainMcpUnregister).toHaveBeenCalledWith(1); });
    });

    it('re-reads per account, since this one is not global', async () => {
      const { rerender } = render(<BrainQueuePanel accountId={1} />);
      await waitFor(() => { expect(api.brainMcpStatus).toHaveBeenCalledWith(1); });

      rerender(<BrainQueuePanel accountId={2} />);
      await waitFor(() => { expect(api.brainMcpStatus).toHaveBeenCalledWith(2); });
    });

    it('surfaces a failure and leaves the switch unflipped', async () => {
      vi.mocked(api.brainMcpRegister).mockRejectedValue(new Error('no vault configured'));
      render(<BrainQueuePanel accountId={1} />);
      await waitFor(() => { expect(toggle()).toBeTruthy(); });

      fireEvent.click(toggle());

      // Not optimistic: flipping before the write lands would claim residue in
      // a Claude config dir that was never created.
      expect(await screen.findByText('no vault configured')).toBeTruthy();
      expect((toggle() as HTMLInputElement).checked).toBe(false);
    });
  });
});
