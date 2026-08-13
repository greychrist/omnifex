// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BrainSources } from '@/components/brain/BrainSources';
import { api, type BrainSourcePreview, type BrainSourceSummary } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    brainListSources: vi.fn(),
    brainSourcePreview: vi.fn(),
    brainIndexSelection: vi.fn(),
    brainCurrentRun: vi.fn(),
    onBrainRunProgress: vi.fn(),
    brainSetExcludedProjects: vi.fn(),
  },
}));

/**
 * Hands back the callback the component subscribed with, so a test can push
 * progress frames the way the main process would.
 */
function runProgressListener(): (run: unknown) => void {
  const calls = vi.mocked(api.onBrainRunProgress).mock.calls;
  if (calls.length === 0) throw new Error('component never subscribed to run progress');
  return calls[calls.length - 1][0] as (run: unknown) => void;
}

// The queue panel has its own tests; here it only needs to report which
// account it was handed, which is what keeps these assertions about the
// sources list rather than about queue depth.
vi.mock('@/components/brain/BrainQueuePanel', () => ({
  // Only the actions half renders here now — the persistent switches moved to
  // the Brain tab's Settings tab.
  BrainQueueActions: (
    { accountId, refreshToken }: { accountId: number | null; refreshToken?: number },
  ) => (
    <div data-testid="queue-panel" data-refresh={String(refreshToken ?? 'undefined')}>
      {String(accountId)}
    </div>
  ),
}));

function summary(over: Partial<BrainSourceSummary> = {}): BrainSourceSummary {
  return {
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
    label: '/Users/dev/omnifex',
    mtimeMs: 1_700_000_000_000,
    size: 40_960,
    admitted: true,
    reason: '4 prompts, 3 assistant replies',
    status: null,
    changed: true,
    excluded: false,
    ...over,
  };
}

function preview(over: Partial<BrainSourcePreview> = {}): BrainSourcePreview {
  return {
    itemKey: 'sess-a',
    prose: 'USER: do the thing',
    notePaths: [],
    truncated: false,
    admitted: true,
    reason: 'ok',
    metadata: {
      kind: 'session' as const,
      sessionId: 'sess-a', projectPath: '/repo', gitBranch: 'main',
      models: ['claude-opus-5'], cliVersion: '2.1.228',
      startedAt: null, endedAt: null, durationMs: null,
      promptCount: 4, proseCount: 3, filesTouched: [], terminalStatus: 'completed',
    },
    ...over,
  };
}

describe('BrainSources', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainListSources).mockResolvedValue([]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(null);
    vi.mocked(api.brainSetExcludedProjects).mockResolvedValue(undefined);
    vi.mocked(api.brainIndexSelection).mockResolvedValue({
      written: 1, skipped: 0,
      results: [{ itemKey: 'sess-a', notesWritten: ['Subsystems/A.md'], skipped: false, reason: '1 note(s) written' }],
    });
    vi.mocked(api.brainCurrentRun).mockResolvedValue(null);
    vi.mocked(api.onBrainRunProgress).mockReturnValue(() => {});
  });

  it('lists discovered items for the given account', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    expect(await screen.findByText('/Users/dev/omnifex')).toBeTruthy();
    expect(api.brainListSources).toHaveBeenCalledWith(1, { includeExcluded: true });
  });

  it('shows why a skipped item was skipped', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([
      summary({ admitted: false, reason: 'fewer than 2 prompts (1)' }),
    ]);
    render(<BrainSources accountId={1} />);
    expect(await screen.findByText(/fewer than 2 prompts/)).toBeTruthy();
  });

  it('loads the distilled preview when an item is selected', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));

    expect(await screen.findByText(/USER: do the thing/)).toBeTruthy();
    expect(api.brainSourcePreview).toHaveBeenCalledWith(1, 'sess-a');
  });

  it('warns when the preview was truncated to the ceiling', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview({ truncated: true }));
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    // Without this the reader cannot tell they are looking at a tail, which is
    // the same failure the distiller's own marker exists to prevent.
    expect(await screen.findByText(/truncated/i)).toBeTruthy();
  });

  it('drops the selection when the account changes', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview({ prose: 'PERSONAL PROSE' }));
    const { rerender } = render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/PERSONAL PROSE/);

    vi.mocked(api.brainListSources).mockResolvedValue([]);
    rerender(<BrainSources accountId={2} />);

    // An item key is only meaningful inside the account it came from. Holding
    // a selection across a switch would render one account's distilled
    // transcript under another account's header — the same rule BrainTab
    // applies to note selection.
    await waitFor(() => {
      expect(screen.queryByText(/PERSONAL PROSE/)).toBeNull();
    });
  });

  it('surfaces a listing failure instead of rendering an empty list', async () => {
    vi.mocked(api.brainListSources).mockRejectedValue(new Error('config dir unreadable'));
    render(<BrainSources accountId={1} />);
    expect(await screen.findByText(/config dir unreadable/)).toBeTruthy();
  });

  it('asks for nothing when no account is selected', () => {
    render(<BrainSources accountId={null} />);
    expect(api.brainListSources).not.toHaveBeenCalled();
  });

  it('indexes the selected item and refreshes the listing', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);
    fireEvent.click(screen.getByRole('button', { name: /^index$/i }));

    // A one-row run is still a run: it goes through the same main-process path
    // so it survives the sub-tab switch that used to erase it.
    await waitFor(() => {
      expect(api.brainIndexSelection).toHaveBeenCalledWith(1, ['sess-a']);
    });
    // Refreshing is what turns the row's status from null to indexed. Without
    // it the button looks like it did nothing.
    await waitFor(() => { expect(api.brainListSources).toHaveBeenCalledTimes(2); });
  });

  it('offers no Index button for an item the gate rejected', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary({ admitted: false, reason: 'no prose' })]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview({ admitted: false, reason: 'no prose' }));
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);
    // Indexing a rejected item would spend a token the gate exists to save.
    expect(screen.queryByRole('button', { name: /^index$/i })).toBeNull();
  });

  it('reports a skipped result rather than claiming success', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    vi.mocked(api.brainIndexSelection).mockResolvedValue({
      written: 0, skipped: 1,
      results: [{ itemKey: 'sess-a', notesWritten: [], skipped: true, reason: 'validation blew up' }],
    });
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);
    fireEvent.click(screen.getByRole('button', { name: /^index$/i }));

    expect(await screen.findByText(/validation blew up/)).toBeTruthy();
  });

  /** A whole-run failure — no vault, a run already going — not a per-item one. */
  it('surfaces an indexing failure', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    vi.mocked(api.brainIndexSelection).mockRejectedValue(new Error('no vault configured'));
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);
    fireEvent.click(screen.getByRole('button', { name: /^index$/i }));

    expect(await screen.findByText(/no vault configured/)).toBeTruthy();
  });

  /**
   * The preview is a consequence of a selection, so with nothing selected it
   * has nothing to say — and half the pane spent saying "select something" is
   * half the pane not showing rows.
   */
  it('renders no preview panel until a row is selected', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    await screen.findByText('/Users/dev/omnifex');

    expect(screen.queryByRole('button', { name: /close preview/i })).toBeNull();
    expect(api.brainSourcePreview).not.toHaveBeenCalled();
  });

  it('closes the preview on the X', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);

    fireEvent.click(screen.getByRole('button', { name: /close preview/i }));

    await waitFor(() => { expect(screen.queryByText(/USER: do the thing/)).toBeNull(); });
  });

  it('deselects when the press lands away from the table', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);

    fireEvent.mouseDown(document.body);

    await waitFor(() => { expect(screen.queryByText(/USER: do the thing/)).toBeNull(); });
  });

  /**
   * A mousedown inside the preview must NOT deselect: it would unmount the
   * panel before the click reached the button being pressed.
   */
  it('keeps the preview open when the press lands inside it', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    const prose = await screen.findByText(/USER: do the thing/);

    fireEvent.mouseDown(prose);

    expect(screen.getByText(/USER: do the thing/)).toBeTruthy();
  });

  /**
   * A disabled button whose label changed was the only sign a 20-second model
   * call was running, and it sits in the preview — off to the side of where
   * the user is looking.
   */
  it('announces an indexing run above the table, not just on the button', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    // Never settles, so the run stays in flight for the assertions.
    vi.mocked(api.brainIndexSelection).mockReturnValue(
      new Promise(() => {}) as ReturnType<typeof api.brainIndexSelection>,
    );
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);
    fireEvent.click(screen.getByRole('button', { name: /^index$/i }));

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/indexing/i);
    // Names what is being worked on, so it is not just a moving bar.
    expect(banner.textContent).toContain('sess-a');

    // The main process ends a run by pushing null, not by this call returning.
    runProgressListener()(null);
    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull(); });
  });

  /**
   * `indexSource` is one opaque await — nothing reports partway through a
   * distill-plus-extract. So a single-item run has no percentage to show, and
   * a determinate bar could only invent one: it read 100% from the first frame
   * and sat there for the whole call, which is the same picture as "finished".
   */
  it('shows an indeterminate bar for a single-item run', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    vi.mocked(api.brainIndexSelection).mockReturnValue(
      new Promise(() => { /* never settles: the run is in flight */ }) as ReturnType<typeof api.brainIndexSelection>,
    );
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);
    fireEvent.click(screen.getByRole('button', { name: /^index$/i }));

    const bar = await screen.findByRole('progressbar');
    // Absent aria-valuenow IS the ARIA spelling of indeterminate.
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
  });

  /**
   * The bar counts items FINISHED, not items started. Counting starts put it
   * one item ahead the whole way: it opened at 1/N before any work happened
   * and hit 100% as the last item began, so it never showed that item running.
   */
  it('measures a multi-row run by items completed, not items started', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([
      summary({ itemKey: 'a' }), summary({ itemKey: 'b' }),
    ]);
    vi.mocked(api.brainIndexSelection).mockReturnValue(
      new Promise(() => {}) as ReturnType<typeof api.brainIndexSelection>,
    );
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByLabelText('Select a'));
    fireEvent.click(screen.getByLabelText('Select b'));
    fireEvent.click(screen.getByRole('button', { name: /index selected \(2\)/i }));

    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('2');
    // First item in flight, nothing done yet.
    expect(bar.getAttribute('aria-valuenow')).toBe('0');

    const push = runProgressListener();
    push({ accountId: 1, total: 2, completed: 1, item: 'b', written: 1, skipped: 0 });

    // Second item in flight, one done.
    await waitFor(() => {
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    });
  });

  it('counts through a multi-row run in the same banner', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([
      summary({ itemKey: 'a' }), summary({ itemKey: 'b' }),
    ]);
    vi.mocked(api.brainIndexSelection).mockReturnValue(
      new Promise(() => {}) as ReturnType<typeof api.brainIndexSelection>,
    );
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByLabelText('Select a'));
    fireEvent.click(screen.getByLabelText('Select b'));
    fireEvent.click(screen.getByRole('button', { name: /index selected \(2\)/i }));

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/1 of 2/);
  });

  /**
   * The pane unmounts whenever the Brain tab's sub-tab changes, so a run
   * started here and left running is, on return, a run this component never
   * saw begin. Asking the main process on mount is the only way to draw it.
   */
  it('rebuilds the banner for a run that started before it mounted', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainCurrentRun).mockResolvedValue({
      accountId: 1, total: 4, completed: 2, item: 'sess-c', written: 2, skipped: 0,
    });
    render(<BrainSources accountId={1} />);

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/3 of 4/);
    expect(banner.textContent).toContain('sess-c');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
  });

  it('asks only about its own account\'s run', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={7} />);
    await waitFor(() => { expect(api.brainCurrentRun).toHaveBeenCalledWith(7); });
  });

  it('follows a run through pushed progress frames', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    await screen.findByText('/Users/dev/omnifex');

    const push = runProgressListener();
    push({ accountId: 1, total: 3, completed: 1, item: 'sess-b', written: 1, skipped: 0 });

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/2 of 3/);
  });

  /**
   * The terminating null is what ends the banner. Without honouring it the bar
   * would hang on its last frame for as long as the pane stayed mounted.
   */
  it('drops the banner and re-lists when the run reports it ended', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    await screen.findByText('/Users/dev/omnifex');

    const push = runProgressListener();
    push({ accountId: 1, total: 1, completed: 0, item: 'sess-a', written: 0, skipped: 0 });
    await screen.findByRole('status');

    push(null);

    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull(); });
    // A finished run changed row statuses; leaving the list stale is what made
    // the button look like it had done nothing.
    await waitFor(() => { expect(api.brainListSources).toHaveBeenCalledTimes(2); });
  });

  /** Another account's run is not this pane's business to draw. */
  it('ignores progress frames belonging to a different account', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    await screen.findByText('/Users/dev/omnifex');

    runProgressListener()({
      accountId: 2, total: 3, completed: 1, item: 'other-acct', written: 1, skipped: 0,
    });

    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull(); });
  });

  it('unsubscribes from progress when it unmounts', async () => {
    const unsubscribe = vi.fn();
    vi.mocked(api.onBrainRunProgress).mockReturnValue(unsubscribe);
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    const { unmount } = render(<BrainSources accountId={1} />);
    await screen.findByText('/Users/dev/omnifex');

    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });

  it('runs a multi-row selection through the main process, not a local loop', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([
      summary({ itemKey: 'a' }), summary({ itemKey: 'b' }),
    ]);
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByLabelText('Select a'));
    fireEvent.click(screen.getByLabelText('Select b'));
    fireEvent.click(screen.getByRole('button', { name: /index selected \(2\)/i }));

    // One call carrying the whole selection: a per-item loop in the renderer is
    // what died with the component.
    await waitFor(() => {
      expect(api.brainIndexSelection).toHaveBeenCalledWith(1, ['a', 'b']);
    });
  });

  /**
   * The stats bar ("Spent indexing", "Notes in vault") is a SIBLING of this
   * pane, reading `brain_stats` on its own. Nothing here can re-read it, so a
   * finished run left the cost figure showing a number from before the spend.
   */
  it('tells its owner the vault changed when a run ends', async () => {
    const onVaultChanged = vi.fn();
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} onVaultChanged={onVaultChanged} />);
    await screen.findByText('/Users/dev/omnifex');

    const push = runProgressListener();
    push({ accountId: 1, total: 1, completed: 0, item: 'sess-a', written: 0, skipped: 0 });
    push(null);

    await waitFor(() => { expect(onVaultChanged).toHaveBeenCalled(); });
  });

  it('tells its owner the vault changed when Refresh is pressed', async () => {
    const onVaultChanged = vi.fn();
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} onVaultChanged={onVaultChanged} />);
    await screen.findByText('/Users/dev/omnifex');

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    // Refresh has to mean "re-read everything on this page", or the figure the
    // user is staring at stays wrong no matter how many times they press it.
    await waitFor(() => { expect(onVaultChanged).toHaveBeenCalled(); });
  });

  /** Another account's run must not trigger a re-read of this one's figures. */
  it('stays quiet for a run belonging to a different account', async () => {
    const onVaultChanged = vi.fn();
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} onVaultChanged={onVaultChanged} />);
    await screen.findByText('/Users/dev/omnifex');

    runProgressListener()({
      accountId: 2, total: 1, completed: 1, item: 'other', written: 1, skipped: 0,
    });

    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull(); });
    expect(onVaultChanged).not.toHaveBeenCalled();
  });

  /**
   * The queue chip sits on the same bar as the Refresh button, so "refresh"
   * has to reach it too — a background drain changes those counts with no
   * action in this pane to notice it.
   */
  it('refreshes the queue counts when Refresh is pressed', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    await screen.findByText('/Users/dev/omnifex');
    const before = screen.getByTestId('queue-panel').getAttribute('data-refresh');
    expect(before).not.toBe('undefined');

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      expect(screen.getByTestId('queue-panel').getAttribute('data-refresh')).not.toBe(before);
    });
  });

  it('re-lists on demand when Refresh is pressed', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    await screen.findByText('/Users/dev/omnifex');
    expect(api.brainListSources).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => { expect(api.brainListSources).toHaveBeenCalledTimes(2); });
  });

  /**
   * Enabled mid-run on purpose: a run only re-lists when the WHOLE selection
   * finishes, so this is the one way to watch statuses land one at a time.
   */
  it('keeps Refresh usable while a run is in flight', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    await screen.findByText('/Users/dev/omnifex');

    runProgressListener()({
      accountId: 1, total: 5, completed: 1, item: 'sess-a', written: 1, skipped: 0,
    });
    await screen.findByRole('status');

    expect(screen.getByRole('button', { name: /refresh/i }).hasAttribute('disabled')).toBe(false);
  });

  it('shows a listing error even with no row selected', async () => {
    vi.mocked(api.brainListSources).mockRejectedValue(new Error('config dir unreadable'));
    render(<BrainSources accountId={1} />);
    // The preview used to host this, which put it behind a selection that a
    // listing failure can never produce.
    expect(await screen.findByText(/config dir unreadable/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /close preview/i })).toBeNull();
  });
});
