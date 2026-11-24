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

function runProgressListener(): (run: unknown) => void {
  const calls = vi.mocked(api.onBrainRunProgress).mock.calls;
  if (calls.length === 0) throw new Error('component never subscribed to run progress');
  return calls[calls.length - 1][0] as (run: unknown) => void;
}

vi.mock('@/components/brain/BrainQueuePanel', () => ({
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

    await waitFor(() => {
      expect(api.brainIndexSelection)
        .toHaveBeenCalledWith(1, ['sess-a'], { force: true });
    });
    await waitFor(() => { expect(api.brainListSources).toHaveBeenCalledTimes(2); });
  });

  it('offers no Index button for an item the gate rejected', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary({ admitted: false, reason: 'no prose' })]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview({ admitted: false, reason: 'no prose' }));
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);
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

  it('keeps the preview open when the press lands inside it', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    const prose = await screen.findByText(/USER: do the thing/);

    fireEvent.mouseDown(prose);

    expect(screen.getByText(/USER: do the thing/)).toBeTruthy();
  });

  it('keeps the preview open when the press lands on the splitter', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);

    fireEvent.mouseDown(screen.getByRole('separator', { name: /resize the sources list/i }));

    expect(screen.getByText(/USER: do the thing/)).toBeTruthy();
  });

  it('announces an indexing run above the table, not just on the button', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    // Never settles, so the run stays in flight for the assertions.
    vi.mocked(api.brainIndexSelection).mockReturnValue(
      new Promise(() => {}),
    );
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);
    fireEvent.click(screen.getByRole('button', { name: /^index$/i }));

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/indexing/i);
    expect(banner.textContent).toContain('sess-a');

    // The main process ends a run by pushing null, not by this call returning.
    runProgressListener()(null);
    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull(); });
  });

  it('shows an indeterminate bar for a single-item run', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    vi.mocked(api.brainIndexSelection).mockReturnValue(
      new Promise(() => { /* never settles: the run is in flight */ }),
    );
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);
    fireEvent.click(screen.getByRole('button', { name: /^index$/i }));

    const bar = await screen.findByRole('progressbar');
    // Absent aria-valuenow IS the ARIA spelling of indeterminate.
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
  });

  it('measures a multi-row run by items completed, not items started', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([
      summary({ itemKey: 'a' }), summary({ itemKey: 'b' }),
    ]);
    vi.mocked(api.brainIndexSelection).mockReturnValue(
      new Promise(() => {}),
    );
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByLabelText('Select a'));
    fireEvent.click(screen.getByLabelText('Select b'));
    fireEvent.click(screen.getByRole('button', { name: /index selected \(2\)/i }));

    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('2');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');

    const push = runProgressListener();
    push({ accountId: 1, total: 2, completed: 1, item: 'b', written: 1, skipped: 0 });

    await waitFor(() => {
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    });
  });

  it('counts through a multi-row run in the same banner', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([
      summary({ itemKey: 'a' }), summary({ itemKey: 'b' }),
    ]);
    vi.mocked(api.brainIndexSelection).mockReturnValue(
      new Promise(() => {}),
    );
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByLabelText('Select a'));
    fireEvent.click(screen.getByLabelText('Select b'));
    fireEvent.click(screen.getByRole('button', { name: /index selected \(2\)/i }));

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/1 of 2/);
  });

  it('rebuilds the banner for a run that started before it mounted', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainCurrentRun).mockResolvedValue({
      accountId: 1, total: 4, completed: 2, item: 'sess-c', label: 'omnifex',
      phase: 'extracting', startedAt: Date.now(), written: 2, skipped: 0,
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

  it('keeps the counter, and names the stage and the item, for a one-item run', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    await screen.findByText('/Users/dev/omnifex');

    runProgressListener()({
      accountId: 1, total: 1, completed: 0, item: 'sess-a', label: 'pi-tuitive',
      phase: 'extracting', startedAt: Date.now() - 5_000, written: 0, skipped: 0,
    });

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/1 of 1/);
    expect(banner.textContent).toMatch(/extracting/);
    expect(banner.textContent).toContain('pi-tuitive');
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

  it('drops the banner and re-lists when the run reports it ended', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    await screen.findByText('/Users/dev/omnifex');

    const push = runProgressListener();
    push({ accountId: 1, total: 1, completed: 0, item: 'sess-a', written: 0, skipped: 0 });
    await screen.findByRole('status');

    push(null);

    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull(); });
    await waitFor(() => { expect(api.brainListSources).toHaveBeenCalledTimes(2); });
  });

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

    await waitFor(() => {
      expect(api.brainIndexSelection).toHaveBeenCalledWith(1, ['a', 'b'], { force: true });
    });
  });

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

    await waitFor(() => { expect(onVaultChanged).toHaveBeenCalled(); });
  });

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
    expect(await screen.findByText(/config dir unreadable/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /close preview/i })).toBeNull();
  });
});
