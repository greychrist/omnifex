// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { UsageDetailPopover } from '../UsageDetailPopover';
import type { UsageRunResult, UsageRunData } from '@/lib/api';

const EMPTY_TABLE = { rows: [], more_count: null };

function makeData(loops: UsageRunData['loops']): UsageRunResult {
  return {
    ok: true,
    observed_at: 1_000,
    raw: '',
    parsed: {
      stale: false,
      session: {
        cost_usd: 0, api_duration_s: 0, wall_duration_s: 0,
        code_added: 0, code_removed: 0,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
      },
      windows: [],
      contributing: [],
      skills: EMPTY_TABLE,
      subagents: EMPTY_TABLE,
      plugins: EMPTY_TABLE,
      mcp_servers: EMPTY_TABLE,
      loops,
    },
  };
}

function renderPopover(loops: UsageRunData['loops']) {
  return render(
    <UsageDetailPopover
      open
      onOpenChange={() => {}}
      trigger={<button type="button">usage</button>}
      data={makeData(loops)}
      loading={false}
      onRefresh={() => {}}
      nowMs={1_000}
    />,
  );
}

describe('UsageDetailPopover — Loops section', () => {
  afterEach(cleanup);

  it('renders each loop with its cadence, runs and token totals', () => {
    renderPopover({
      rows: [
        { prompt: 'check the deploy', every: '5m', runs: 12, tokens: '480.2k', per_run: '40.0k', last_run: '2h ago' },
      ],
      more_count: 4,
    });

    expect(screen.getByText('Loops')).toBeTruthy();
    expect(screen.getByText('check the deploy')).toBeTruthy();
    expect(screen.getByText('every 5m')).toBeTruthy();
    expect(screen.getByText('12 runs')).toBeTruthy();
    expect(screen.getByText('480.2k')).toBeTruthy();
    expect(screen.getByText('40.0k/run')).toBeTruthy();
    expect(screen.getByText('2h ago')).toBeTruthy();
    expect(screen.getByText('… 4 more')).toBeTruthy();
  });

  it('omits the per-run figure when the CLI dropped that column', () => {
    renderPopover({
      rows: [
        { prompt: 'nightly sweep', every: '1d', runs: 7, tokens: '210.0k', per_run: null, last_run: '3d ago' },
      ],
      more_count: null,
    });

    expect(screen.getByText('nightly sweep')).toBeTruthy();
    expect(screen.queryByText(/\/run$/)).toBeNull();
  });

  it('renders no Loops section at all when the account has no loops', () => {
    renderPopover({ rows: [], more_count: null });
    expect(screen.queryByText('Loops')).toBeNull();
  });
});
