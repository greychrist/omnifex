// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BrainSources } from '@/components/brain/BrainSources';
import { api, type BrainSourcePreview, type BrainSourceSummary } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    brainListSources: vi.fn(),
    brainSourcePreview: vi.fn(),
    brainIndexSource: vi.fn(),
    brainSetExcludedProjects: vi.fn(),
  },
}));

// The queue panel has its own tests; here it only needs to report which
// account it was handed, which is what keeps these assertions about the
// sources list rather than about queue depth.
vi.mock('@/components/brain/BrainQueuePanel', () => ({
  // Only the actions half renders here now — the persistent switches moved to
  // the Brain tab's Settings tab.
  BrainQueueActions: ({ accountId }: { accountId: number | null }) => (
    <div data-testid="queue-panel">{String(accountId)}</div>
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
    vi.mocked(api.brainIndexSource).mockResolvedValue({
      itemKey: 'sess-a', notesWritten: ['Subsystems/A.md'], skipped: false, reason: '1 note(s) written',
    });
    vi.mocked(api.brainSetExcludedProjects).mockResolvedValue(undefined);
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

    await waitFor(() => { expect(api.brainIndexSource).toHaveBeenCalledWith(1, 'sess-a'); });
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
    vi.mocked(api.brainIndexSource).mockResolvedValue({
      itemKey: 'sess-a', notesWritten: [], skipped: true, reason: 'validation blew up',
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
    vi.mocked(api.brainIndexSource).mockRejectedValue(new Error('no vault configured'));
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
    let finish: (r: { itemKey: string; notesWritten: string[]; skipped: boolean; reason: string }) => void = () => {};
    vi.mocked(api.brainIndexSource).mockReturnValue(
      new Promise((r) => { finish = r; }) as ReturnType<typeof api.brainIndexSource>,
    );
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('/Users/dev/omnifex'));
    await screen.findByText(/USER: do the thing/);
    fireEvent.click(screen.getByRole('button', { name: /^index$/i }));

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/indexing/i);
    // Names what is being worked on, so it is not just a moving bar.
    expect(banner.textContent).toContain('sess-a');

    finish({ itemKey: 'sess-a', notesWritten: ['A.md'], skipped: false, reason: 'ok' });
    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull(); });
  });

  it('counts through a multi-row run in the same banner', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([
      summary({ itemKey: 'a' }), summary({ itemKey: 'b' }),
    ]);
    let finish: (r: { itemKey: string; notesWritten: string[]; skipped: boolean; reason: string }) => void = () => {};
    vi.mocked(api.brainIndexSource).mockReturnValue(
      new Promise((r) => { finish = r; }) as ReturnType<typeof api.brainIndexSource>,
    );
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByLabelText('Select a'));
    fireEvent.click(screen.getByLabelText('Select b'));
    fireEvent.click(screen.getByRole('button', { name: /index selected \(2\)/i }));

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/1 of 2/);
    finish({ itemKey: 'a', notesWritten: [], skipped: false, reason: 'ok' });
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
