// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { BrainRunIndicator } from '@/components/brain/BrainRunIndicator';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    brainActiveRun: vi.fn(),
    onBrainRunProgress: vi.fn(),
  },
}));

/** Hands back the callback the component subscribed with. */
function pushRun(): (run: unknown) => void {
  const calls = vi.mocked(api.onBrainRunProgress).mock.calls;
  if (calls.length === 0) throw new Error('component never subscribed to run progress');
  return calls[calls.length - 1][0] as (run: unknown) => void;
}

const RUN = {
  accountId: 1, total: 20, completed: 3, item: 'sess-abc', written: 2, skipped: 1,
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

  it('shows nothing when no run is in flight', async () => {
    render(<BrainRunIndicator accounts={ACCOUNTS} />);
    await waitFor(() => {
      expect(api.brainActiveRun).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('brain-run-indicator')).toBeNull();
  });

  /**
   * The requirement that drove this component: a drain runs for a long time
   * with minutes between frames, so a mount that waited for the next push
   * would show nothing for minutes while indexing was plainly happening.
   */
  it('seeds itself from the main process on mount, before any frame arrives', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue(RUN);

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByTestId('brain-run-indicator')).toBeTruthy();
    expect(screen.getByText(/3 of 20/)).toBeTruthy();
  });

  it('names the vault being written to', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({ ...RUN, accountId: 2 });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    // A run belongs to exactly one account's vault. An unlabelled counter would
    // leave the user guessing which subscription is being spent.
    expect(await screen.findByText(/Work/)).toBeTruthy();
  });

  it('follows pushed frames after mount', async () => {
    render(<BrainRunIndicator accounts={ACCOUNTS} />);
    await waitFor(() => {
      expect(api.onBrainRunProgress).toHaveBeenCalled();
    });

    pushRun()(RUN);
    expect(await screen.findByText(/3 of 20/)).toBeTruthy();

    pushRun()({ ...RUN, completed: 4 });
    expect(await screen.findByText(/4 of 20/)).toBeTruthy();
  });

  it('disappears on the terminating null frame', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue(RUN);
    render(<BrainRunIndicator accounts={ACCOUNTS} />);
    expect(await screen.findByTestId('brain-run-indicator')).toBeTruthy();

    pushRun()(null);

    // Without this the bar would hang at the last frame forever, claiming a run
    // that finished minutes ago.
    await waitFor(() => {
      expect(screen.queryByTestId('brain-run-indicator')).toBeNull();
    });
  });

  it('falls back to the account id when the name is unknown', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({ ...RUN, accountId: 99 });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    // An account deleted mid-run still has a vault and still has a run. Showing
    // nothing would be worse than showing the id.
    expect(await screen.findByText(/account 99/i)).toBeTruthy();
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
