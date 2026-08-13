// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainStatsPanel } from '@/components/brain/BrainStatsPanel';
import { api, type BrainVaultStats } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { brainStats: vi.fn() },
}));

function stats(noteCount: number, curated: string[] = []): BrainVaultStats {
  return {
    noteCount,
    totalBytes: noteCount * 1024,
    byType: { Subsystem: noteCount },
    medianBytes: 1024,
    largestBytes: 2048,
    largestNote: 'Subsystems/A.md',
    estimatedTokens: { median: 256, largest: 512, vault: noteCount * 256 },
    timelineBuckets: [{ label: 'none', count: noteCount }],
    qualifyingCount: 0,
    recentlyCurated: curated.map((relPath) => ({ relPath, curatedAt: '2026-08-13' })),
  };
}

describe('BrainStatsPanel', () => {
  beforeEach(() => { vi.mocked(api.brainStats).mockReset(); });
  afterEach(() => { cleanup(); });

  it('shows the selected account figures', async () => {
    vi.mocked(api.brainStats).mockResolvedValue(stats(83));
    render(<BrainStatsPanel accountId={1} />);
    await waitFor(() => { expect(screen.getByText('83')).toBeTruthy(); });
  });

  /**
   * The invariant `useBrainVault` states and every other Brain pane honours:
   * "Showing account 1's note list under account 2's badge for even one frame
   * is exactly the cross-account leak the per-vault design exists to make
   * impossible." This panel must clear on switch, not on resolve.
   */
  it('never shows the previous account figures after a switch', async () => {
    vi.mocked(api.brainStats).mockResolvedValue(stats(83, ['Subsystems/Personal.md']));
    const { rerender } = render(<BrainStatsPanel accountId={1} />);
    await waitFor(() => { expect(screen.getByText('83')).toBeTruthy(); });

    // The work account's read is still in flight.
    vi.mocked(api.brainStats).mockReturnValue(new Promise(() => {}) as Promise<BrainVaultStats>);
    rerender(<BrainStatsPanel accountId={2} />);

    expect(screen.queryByText('83')).toBeNull();
    expect(screen.queryByText('Subsystems/Personal.md')).toBeNull();
  });

  it('does not carry one account read failure into the next account', async () => {
    vi.mocked(api.brainStats).mockRejectedValue(new Error('vault on fire'));
    const { rerender } = render(<BrainStatsPanel accountId={1} />);
    await waitFor(() => { expect(screen.getByText('vault on fire')).toBeTruthy(); });

    vi.mocked(api.brainStats).mockReturnValue(new Promise(() => {}) as Promise<BrainVaultStats>);
    rerender(<BrainStatsPanel accountId={2} />);

    expect(screen.queryByText('vault on fire')).toBeNull();
  });

  it('renders nothing without an account', () => {
    const { container } = render(<BrainStatsPanel accountId={null} />);
    expect(container.firstChild).toBeNull();
  });
});
