// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainStatsPanel } from '@/components/brain/BrainStatsPanel';
import { api, type BrainVaultStats } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { brainStats: vi.fn() },
}));

function stats(noteCount: number): BrainVaultStats {
  return {
    noteCount,
    totalBytes: noteCount * 1024,
    byType: { Subsystem: noteCount },
    medianBytes: 1024,
    largestBytes: 2048,
    largestNote: 'Subsystems/A.md',
    estimatedTokens: { median: 256, largest: 512, vault: noteCount * 256 },
    // Buckets partition the notes; they must not simply repeat the total, or
    // an assertion on the note count matches the histogram too.
    timelineBuckets: [
      { label: 'none', count: Math.max(0, noteCount - 1) },
      { label: '1–3', count: noteCount > 0 ? 1 : 0 },
    ],
    qualifyingCount: 0,
    spentUsd: 0,
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
    vi.mocked(api.brainStats).mockResolvedValue(stats(83));
    const { rerender } = render(<BrainStatsPanel accountId={1} />);
    await waitFor(() => { expect(screen.getByText('83')).toBeTruthy(); });

    // The work account's read is still in flight.
    vi.mocked(api.brainStats).mockReturnValue(new Promise(() => {}) as Promise<BrainVaultStats>);
    rerender(<BrainStatsPanel accountId={2} />);

    expect(screen.queryByText('83')).toBeNull();
  });

  /**
   * The panel is a row of figures and nothing else. A trailing list of
   * curated note paths used to wrap under it, growing the card's header band
   * by an unpredictable number of lines and naming files nobody had asked
   * about. Curation is still observable through "Ready to curate" and the
   * vault's own git history.
   */
  it('does not list recently curated notes', async () => {
    vi.mocked(api.brainStats).mockResolvedValue(stats(83));
    render(<BrainStatsPanel accountId={1} />);
    await waitFor(() => { expect(screen.getByText('83')).toBeTruthy(); });

    expect(screen.queryByText(/recently curated/i)).toBeNull();
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

/**
 * The histogram used to render as one run-on string —
 * "none: 0  1–3: 0  4–7: 0  8–15: 0  16+: 0" — under the label "Timeline
 * entries per note". Two problems: the label named the mechanism (a Timeline
 * is a section in a Markdown file) rather than the thing being counted, and
 * the reading direction was ambiguous. "1–3: 4" is four NOTES that each have
 * one to three entries, but it reads just as easily as the reverse.
 */
describe('BrainStatsPanel — note history', () => {
  beforeEach(() => { vi.mocked(api.brainStats).mockReset(); });
  afterEach(() => { cleanup(); });

  function withBuckets(buckets: { label: string; count: number }[]): BrainVaultStats {
    return { ...stats(20), timelineBuckets: buckets, qualifyingCount: 3 };
  }

  it('says what curating actually does, not just that it is possible', async () => {
    // "8+ entries can be curated" assumed the reader knew what curation was.
    // The copy has to carry the consequence — smaller notes, cheaper recall —
    // because the word itself explains nothing.
    vi.mocked(api.brainStats).mockResolvedValue(withBuckets([{ label: '8–15', count: 2 }]));
    render(<BrainStatsPanel accountId={1} />);
    await waitFor(() => {
      // Both the backlog figure and the histogram now explain themselves, so
      // match the histogram's own caption rather than the shared word.
      expect(screen.getByText(/8\+ entries: older ones can be summari[sz]ed/i)).toBeTruthy();
    });
    expect(screen.queryByText('8+ entries can be curated')).toBeNull();
  });

  it('explains the backlog figure in terms of what it costs', async () => {
    vi.mocked(api.brainStats).mockResolvedValue(withBuckets([{ label: '8–15', count: 2 }]));
    render(<BrainStatsPanel accountId={1} />);
    // The count's own caption names the outcome, not the jargon.
    await waitFor(() => { expect(screen.getByText(/cheaper to recall/i)).toBeTruthy(); });
  });

  it('labels the histogram by what it counts, not by the file section', async () => {
    vi.mocked(api.brainStats).mockResolvedValue(withBuckets([{ label: '1–3', count: 4 }]));
    render(<BrainStatsPanel accountId={1} />);
    await waitFor(() => { expect(screen.getByText(/sessions recorded/i)).toBeTruthy(); });
    expect(screen.queryByText(/timeline entries per note/i)).toBeNull();
  });

  it('renders one badge per bucket, each spelling out which side is which', async () => {
    vi.mocked(api.brainStats).mockResolvedValue(withBuckets([
      { label: 'none', count: 9 },
      { label: '1–3', count: 4 },
      { label: '16+', count: 2 },
    ]));
    render(<BrainStatsPanel accountId={1} />);

    const badges = await screen.findAllByTestId('history-bucket');
    expect(badges).toHaveLength(3);
    expect(badges.map((b) => b.textContent)).toEqual(['none9', '1–34', '16+2']);
    // The unambiguous reading lives in the title, where the count is named.
    expect(badges[1].getAttribute('title')).toMatch(/4 notes/i);
    expect(badges[1].getAttribute('title')).toMatch(/1–3/);
  });

  it('marks the buckets that are the curation backlog', async () => {
    // 8+ entries is the curation threshold, so those two buckets are the
    // backlog behind "Ready to curate" — worth telling apart from the tail.
    vi.mocked(api.brainStats).mockResolvedValue(withBuckets([
      { label: '1–3', count: 4 },
      { label: '8–15', count: 2 },
      { label: '16+', count: 1 },
    ]));
    render(<BrainStatsPanel accountId={1} />);
    const badges = await screen.findAllByTestId('history-bucket');
    expect(badges[0].getAttribute('data-curatable')).toBe('false');
    expect(badges[1].getAttribute('data-curatable')).toBe('true');
    expect(badges[2].getAttribute('data-curatable')).toBe('true');
  });

  it('says nothing about a backlog when a bucket is empty', async () => {
    vi.mocked(api.brainStats).mockResolvedValue(withBuckets([
      { label: '8–15', count: 0 },
    ]));
    render(<BrainStatsPanel accountId={1} />);
    const badge = await screen.findByTestId('history-bucket');
    // Above the threshold but empty: nothing to flag.
    expect(badge.getAttribute('data-curatable')).toBe('false');
  });
});

describe('BrainStatsPanel — spend', () => {
  beforeEach(() => { vi.mocked(api.brainStats).mockReset(); });
  afterEach(() => { cleanup(); });

  it('reports what indexing this vault has cost', async () => {
    vi.mocked(api.brainStats).mockResolvedValue({ ...stats(12), spentUsd: 2.4137 });
    render(<BrainStatsPanel accountId={1} />);
    // Two decimals for a running total — this one is read as money, not as a
    // per-run figure where sub-cent precision matters.
    await waitFor(() => { expect(screen.getByText('$2.41')).toBeTruthy(); });
    expect(screen.getByText(/spent indexing/i)).toBeTruthy();
  });

  it('shows nothing spent as $0.00 rather than a blank', async () => {
    vi.mocked(api.brainStats).mockResolvedValue({ ...stats(0), spentUsd: 0 });
    render(<BrainStatsPanel accountId={1} />);
    await waitFor(() => { expect(screen.getByText('$0.00')).toBeTruthy(); });
  });
});
