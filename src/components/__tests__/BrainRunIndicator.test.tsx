// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { BrainRunIndicator } from '@/components/brain/BrainRunIndicator';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    brainActiveRun: vi.fn(),
    onBrainRunProgress: vi.fn(),
  },
}));

function pushRun(): (run: unknown) => void {
  const calls = vi.mocked(api.onBrainRunProgress).mock.calls;
  if (calls.length === 0) throw new Error('component never subscribed to run progress');
  return calls[calls.length - 1][0] as (run: unknown) => void;
}

const RUN = {
  accountId: 1, total: 20, completed: 3, item: 'sess-abc', label: 'pi-tuitive',
  phase: 'extracting' as const, startedAt: 0, written: 2, skipped: 1,
};

const ACCOUNTS = [
  { id: 1, name: 'Personal' },
  { id: 2, name: 'Work' },
];

describe('BrainRunIndicator', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainActiveRun).mockResolvedValue(null);
    vi.mocked(api.onBrainRunProgress).mockReturnValue(() => {});
  });

  // In afterEach: a failed assertion would otherwise leak fake timers into later
  // tests, which then hang on waitFor.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing when no run is in flight', async () => {
    render(<BrainRunIndicator accounts={ACCOUNTS} />);
    await waitFor(() => {
      expect(api.brainActiveRun).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('brain-run-indicator')).toBeNull();
  });

  it('seeds itself from the main process on mount, before any frame arrives', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue(RUN);

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByTestId('brain-run-indicator')).toBeTruthy();
    expect(screen.getByText(/4 of 20/)).toBeTruthy();
  });

  it('names the vault being written to', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({ ...RUN, accountId: 2 });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByText(/Work/)).toBeTruthy();
  });

  it('follows pushed frames after mount', async () => {
    render(<BrainRunIndicator accounts={ACCOUNTS} />);
    await waitFor(() => {
      expect(api.onBrainRunProgress).toHaveBeenCalled();
    });

    pushRun()(RUN);
    expect(await screen.findByText(/4 of 20/)).toBeTruthy();

    pushRun()({ ...RUN, completed: 4 });
    expect(await screen.findByText(/5 of 20/)).toBeTruthy();
  });

  it('disappears on the terminating null frame', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue(RUN);
    render(<BrainRunIndicator accounts={ACCOUNTS} />);
    expect(await screen.findByTestId('brain-run-indicator')).toBeTruthy();

    pushRun()(null);

    await waitFor(() => {
      expect(screen.queryByTestId('brain-run-indicator')).toBeNull();
    });
  });

  it('falls back to the account id when the name is unknown', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({ ...RUN, accountId: 99 });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByText(/account 99/i)).toBeTruthy();
  });

  it('says what it is doing, not just a bare count', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({ ...RUN, accountId: 2 });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByText(/Indexing Work vault · 4 of 20/)).toBeTruthy();
  });

  it('keeps the counter for a single-item run', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({
      ...RUN, accountId: 2, total: 1, completed: 0,
    });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByText(/Indexing Work vault · 1 of 1/)).toBeTruthy();
  });

  it('names the item being worked on', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue(RUN);

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByText('pi-tuitive')).toBeTruthy();
  });

  it('says which stage of the item is running', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({ ...RUN, phase: 'curating' as const });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByText(/curating/)).toBeTruthy();
  });

  it('counts up how long the current item has been running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T10:00:00.000Z'));
    vi.mocked(api.brainActiveRun).mockResolvedValue({
      ...RUN, startedAt: Date.now() - 64_000,
    });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);
    // waitFor does not mix with fake timers.
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText(/1:04/)).toBeTruthy();

    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByText(/1:05/)).toBeTruthy();
  });

  // jsdom cannot hover a Radix trigger, so the detail is read from aria-label.
  it('describes the run without relying on the native title tooltip', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({ ...RUN, accountId: 2 });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);
    const pill = await screen.findByTestId('brain-run-indicator');

    expect(pill.getAttribute('title')).toBeNull();
    const label = pill.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/Work vault/);
    expect(label).toMatch(/sess-abc/);
    expect(label).toMatch(/4 of 20/);
    expect(label).toMatch(/pi-tuitive/);
    expect(label).toMatch(/extracting/);
  });

  it('unsubscribes on unmount', async () => {
    const unsubscribe = vi.fn();
    vi.mocked(api.onBrainRunProgress).mockReturnValue(unsubscribe);

    const { unmount } = render(<BrainRunIndicator accounts={ACCOUNTS} />);
    await waitFor(() => {
      expect(api.onBrainRunProgress).toHaveBeenCalled();
    });
    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
