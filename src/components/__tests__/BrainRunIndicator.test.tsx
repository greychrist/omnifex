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

/** Hands back the callback the component subscribed with. */
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

  // In afterEach, not at the end of the one test that installs them: a failed
  // assertion would otherwise leak fake timers into every later test, which
  // hangs them on waitFor rather than failing them.
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

  /**
   * The requirement that drove this component: a drain runs for a long time
   * with minutes between frames, so a mount that waited for the next push
   * would show nothing for minutes while indexing was plainly happening.
   */
  it('seeds itself from the main process on mount, before any frame arrives', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue(RUN);

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByTestId('brain-run-indicator')).toBeTruthy();
    // Item-positional, matching the Brain tab: 3 done means the 4th is the one
    // being worked on. The same run must not read "3 of 20" here and "4 of 20"
    // there.
    expect(screen.getByText(/4 of 20/)).toBeTruthy();
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
    expect(await screen.findByText(/4 of 20/)).toBeTruthy();

    pushRun()({ ...RUN, completed: 4 });
    expect(await screen.findByText(/5 of 20/)).toBeTruthy();
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

  /**
   * A bare "Work · 3 of 20" reads as a score, not as work in progress. The pill
   * is the only place indexing is visible from outside the Brain tab, so it has
   * to name its own verb.
   */
  it('says what it is doing, not just a bare count', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({ ...RUN, accountId: 2 });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByText(/Indexing Work vault · 4 of 20/)).toBeTruthy();
  });

  /**
   * `total` is recomputed per claimed queue entry, so a background drain that
   * takes the last pending item is ALWAYS a one-item run. Dropping the counter
   * there meant the pill spent most of its life reading "Indexing Personal
   * vault" and nothing else — the report that started this. A steady "1 of 1"
   * is a worse counter and a better status line.
   */
  it('keeps the counter for a single-item run', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({
      ...RUN, accountId: 2, total: 1, completed: 0,
    });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByText(/Indexing Work vault · 1 of 1/)).toBeTruthy();
  });

  /**
   * The whole complaint: a pill that named the vault and nothing else. The
   * item's key is a session UUID, so the name has to come from the run.
   */
  it('names the item being worked on', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue(RUN);

    render(<BrainRunIndicator accounts={ACCOUNTS} />);

    expect(await screen.findByText('pi-tuitive')).toBeTruthy();
  });

  /**
   * One item takes minutes behind a single await. Without the stage, a Sonnet
   * call in flight and a wedged item are the same pill.
   */
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
    // Flush the seed read without waitFor, which does not mix with fake timers.
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText(/1:04/)).toBeTruthy();

    // And it keeps moving on its own: run frames arrive per phase, which can be
    // minutes apart, so a clock that only redrew on a frame would look frozen —
    // exactly the thing it exists to rule out.
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByText(/1:05/)).toBeTruthy();
  });

  /**
   * The native `title=` tooltip is slow, unstyled, and inconsistent with the
   * rest of the titlebar. The detail moves to the app's own tooltip, with an
   * aria-label so the same information survives for assistive tech and for
   * tests, which cannot hover a Radix trigger in jsdom.
   */
  it('describes the run without relying on the native title tooltip', async () => {
    vi.mocked(api.brainActiveRun).mockResolvedValue({ ...RUN, accountId: 2 });

    render(<BrainRunIndicator accounts={ACCOUNTS} />);
    const pill = await screen.findByTestId('brain-run-indicator');

    expect(pill.getAttribute('title')).toBeNull();
    const label = pill.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/Work vault/);
    expect(label).toMatch(/sess-abc/);
    expect(label).toMatch(/4 of 20/);
    // The key AND the name: one identifies the row, the other is readable.
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
