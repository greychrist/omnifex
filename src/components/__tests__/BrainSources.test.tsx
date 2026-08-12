// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BrainSources } from '@/components/brain/BrainSources';
import { api, type BrainSourcePreview, type BrainSourceSummary } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { brainListSources: vi.fn(), brainSourcePreview: vi.fn(), brainIndexSource: vi.fn() },
}));

// The queue panel has its own tests; here it only needs to report which
// account it was handed, which is what keeps these assertions about the
// sources list rather than about queue depth.
vi.mock('@/components/brain/BrainQueuePanel', () => ({
  BrainQueuePanel: ({ accountId }: { accountId: number | null }) => (
    <div data-testid="queue-panel">{String(accountId)}</div>
  ),
}));

function summary(over: Partial<BrainSourceSummary> = {}): BrainSourceSummary {
  return {
    accountId: 1,
    sourceId: 'session',
    itemKey: 'sess-a',
    label: '-Users-dev-omnifex',
    mtimeMs: 1_700_000_000_000,
    admitted: true,
    reason: '4 prompts, 3 assistant replies',
    status: null,
    changed: true,
    ...over,
  };
}

function preview(over: Partial<BrainSourcePreview> = {}): BrainSourcePreview {
  return {
    itemKey: 'sess-a',
    prose: 'USER: do the thing',
    truncated: false,
    admitted: true,
    reason: 'ok',
    metadata: {
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
  });

  it('lists discovered items for the given account', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    render(<BrainSources accountId={1} />);
    expect(await screen.findByText('sess-a')).toBeTruthy();
    expect(api.brainListSources).toHaveBeenCalledWith(1);
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

    fireEvent.click(await screen.findByText('sess-a'));

    expect(await screen.findByText(/USER: do the thing/)).toBeTruthy();
    expect(api.brainSourcePreview).toHaveBeenCalledWith(1, 'sess-a');
  });

  it('warns when the preview was truncated to the ceiling', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview({ truncated: true }));
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('sess-a'));
    // Without this the reader cannot tell they are looking at a tail, which is
    // the same failure the distiller's own marker exists to prevent.
    expect(await screen.findByText(/truncated/i)).toBeTruthy();
  });

  it('drops the selection when the account changes', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview({ prose: 'PERSONAL PROSE' }));
    const { rerender } = render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('sess-a'));
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

    fireEvent.click(await screen.findByText('sess-a'));
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

    fireEvent.click(await screen.findByText('sess-a'));
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

    fireEvent.click(await screen.findByText('sess-a'));
    await screen.findByText(/USER: do the thing/);
    fireEvent.click(screen.getByRole('button', { name: /^index$/i }));

    expect(await screen.findByText(/validation blew up/)).toBeTruthy();
  });

  it('surfaces an indexing failure', async () => {
    vi.mocked(api.brainListSources).mockResolvedValue([summary()]);
    vi.mocked(api.brainSourcePreview).mockResolvedValue(preview());
    vi.mocked(api.brainIndexSource).mockRejectedValue(new Error('no vault configured'));
    render(<BrainSources accountId={1} />);

    fireEvent.click(await screen.findByText('sess-a'));
    await screen.findByText(/USER: do the thing/);
    fireEvent.click(screen.getByRole('button', { name: /^index$/i }));

    expect(await screen.findByText(/no vault configured/)).toBeTruthy();
  });
});
