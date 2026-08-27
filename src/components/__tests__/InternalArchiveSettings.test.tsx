// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const { calls, stats } = vi.hoisted(() => ({
  calls: [] as string[],
  stats: { files: 12, bytes: 3_500_000 },
}));

vi.mock('@/lib/api', () => ({
  api: {
    internalArchiveStats: async () => { calls.push('stats'); return stats; },
    internalArchiveClear: async () => {
      calls.push('clear');
      stats.files = 0;
      stats.bytes = 0;
      return stats;
    },
    saveSetting: async (k: string, v: string) => { calls.push(`save:${k}=${v}`); },
    getSetting: async () => null,
  },
}));

import { InternalArchiveSettings } from '../InternalArchiveSettings';

describe('InternalArchiveSettings', () => {
  beforeEach(() => { calls.length = 0; stats.files = 12; stats.bytes = 3_500_000; });
  afterEach(cleanup);

  it('reports what the archive holds', async () => {
    render(<InternalArchiveSettings />);
    await waitFor(() => { expect(screen.getByText(/12 transcripts/)).toBeTruthy(); });
    expect(screen.getByText(/3\.5 MB/)).toBeTruthy();
  });

  // Deleting is irreversible, so it asks first.
  it('asks before clearing', async () => {
    render(<InternalArchiveSettings />);
    await waitFor(() => { expect(screen.getByText(/12 transcripts/)).toBeTruthy(); });
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(calls).not.toContain('clear');
    expect(screen.getByText(/can't be undone/i)).toBeTruthy();
  });

  it('clears on confirm and re-reads the stats', async () => {
    render(<InternalArchiveSettings />);
    await waitFor(() => { expect(screen.getByText(/12 transcripts/)).toBeTruthy(); });
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => { expect(calls).toContain('clear'); });
    await waitFor(() => { expect(screen.getByText(/nothing archived/i)).toBeTruthy(); });
  });

  // The single most important thing this UI says: clearing does not rewrite
  // the Cost Report. Without it, a user avoids the button forever.
  it('says that cost history survives', async () => {
    render(<InternalArchiveSettings />);
    await waitFor(() => { expect(screen.getByText(/12 transcripts/)).toBeTruthy(); });
    expect(screen.getByText(/cost history is not affected/i)).toBeTruthy();
  });
});
