// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

// recharts needs a real layout box; jsdom gives it zero size and
// ResponsiveContainer then renders nothing. The chart's data shaping is
// covered by costChartPalette's tests, so stub the visual here.
vi.mock('@/components/cost-report/CostChart', () => ({
  CostChart: ({ rows }: { rows: unknown[] }) => <div data-testid="chart">{rows.length} rows</div>,
  CostChartLegend: ({ models }: { models: string[] }) => <div data-testid="legend">{models.join(',')}</div>,
}));

vi.mock('@/contexts/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'gray', setTheme: vi.fn(), isLoading: false }),
}));

// Personal is a Max plan, Work is Enterprise — the mix that exercises the
// notional-dollars caveat.
vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [
      { id: 1, name: 'Personal', subscription_label: 'Max' },
      { id: 2, name: 'Work', subscription_label: 'Enterprise' },
    ],
    refresh: vi.fn(),
    getColor: () => '#3b82f6',
    getIcon: () => null,
    getAccountType: (n: string) => (n === 'Work' ? 'Enterprise' : 'Max'),
  }),
}));

vi.mock('@/hooks', () => ({ useTheme: () => ({ theme: 'gray' }) }));

// vi.mock factories are hoisted above module-level consts, so the recorder
// has to be created inside vi.hoisted to exist by the time the factory runs.
const { calls, record } = vi.hoisted(() => {
  const calls: Record<string, unknown[]> = {};
  const record = <T,>(name: string, value: T) => (params: unknown) => {
    (calls[name] ??= []).push(params);
    return Promise.resolve(value);
  };
  return { calls, record };
});

vi.mock('@/lib/api', () => ({
  api: {
    sessionCostHistoryByModel: record('history', [
      { period: '2026-08-01', model: 'claude-opus-5', cost_usd: 800, request_count: 5000, session_count: 20, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0, is_estimated: 0 },
      { period: '2026-08-02', model: 'claude-sonnet-5', cost_usd: 100, request_count: 100, session_count: 5, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0, is_estimated: 0 },
    ]),
    sessionCostByProject: record('byProject', [
      { project_path: '/Users/me/Repos/personal/omnifex', cost_usd: 700, request_count: 4000, session_count: 30, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      { project_path: '/Users/me/Repos/work/mango', cost_usd: 200, request_count: 1100, session_count: 12, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    ]),
    sessionCostByModel: record('byModel', [
      { model: 'claude-opus-5', cost_usd: 800, request_count: 5000, session_count: 40, input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000_000, cache_write_tokens: 20_000_000 },
    ]),
    sessionCostByProjectModel: record('byProjectModel', []),
    sessionCostComponents: record('components', {
      cost_usd: 900, input_usd: 0.1, output_usd: 135, cache_read_usd: 515, cache_write_usd: 249.9, context_share: 0.85,
    }),
    sessionCostCachingRoi: record('roi', {
      cache_read_tokens: 1_000_000_000, cache_write_tokens: 25_000_000, cache_write_1h_tokens: 20_000_000,
      cache_read_usd: 500, cache_write_usd: 250, read_write_ratio: 40, below_break_even: false,
      saved_usd: 4500, premium_1h_usd: 80,
    }),
    sessionCostSubagentSplit: record('subagents', [
      { is_subagent: 0, cost_usd: 800, request_count: 5400, usd_per_request: 800 / 5400 },
      { is_subagent: 1, cost_usd: 100, request_count: 1200, usd_per_request: 100 / 1200 },
    ]),
    sessionCostTotals: record('totals', {
      cost_usd: 900, request_count: 6600, session_count: 42,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    }),
    sessionCostUnpriced: record('unpriced', []),
    sessionCostSessions: record('sessions', []),
    sessionCostFacets: record('facets', {
      accounts: ['Personal', 'Work'], models: ['claude-opus-5', 'claude-sonnet-5'],
      projects: ['/Users/me/Repos/personal/omnifex', '/Users/me/Repos/work/mango'],
      minDate: '2026-06-10', maxDate: '2026-08-26',
    }),
    sessionCostRescan: record('rescan', { sessionsScanned: 5 }),
  },
}));

import { CostReportView } from '../CostReportView';

describe('CostReportView', () => {
  beforeEach(() => {
    for (const k of Object.keys(calls)) delete calls[k];
    // The page persists its filters, so without this each test inherits the
    // previous one's selection and a "toggle Work on" becomes "toggle it off".
    window.localStorage.clear();
  });
  afterEach(cleanup);

  it('states the component split as a sentence, not just a table', async () => {
    render(<CostReportView />);
    // The reframing is the point: "we spend a lot on re-sending context" is a
    // different and more fixable problem than "we spend a lot on AI".
    await waitFor(() => {
      expect(screen.getByText(/of spend is/)).toBeTruthy();
    });
    // 85% also appears in the per-component share column, 15% likewise —
    // assert on the sentence's own numbers rather than uniqueness.
    expect(screen.getAllByText('85%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('15%').length).toBeGreaterThan(0);
  });

  it('states the subagent efficiency finding with its multiple', async () => {
    render(<CostReportView />);
    await waitFor(() => { expect(screen.getByText(/per request against/)).toBeTruthy(); });
    // 800/5400 = $0.1481 main, 100/1200 = $0.0833 subagent -> 1.8x
    expect(screen.getByText('1.8×')).toBeTruthy();
  });

  it('reports caching ROI as a ratio and does not warn when well above break-even', async () => {
    render(<CostReportView />);
    await waitFor(() => { expect(screen.getAllByText('40:1').length).toBeGreaterThan(0); });
    expect(screen.queryByText(/costing more than it saves/)).toBeNull();
  });

  it('defaults to this month and both scopes', async () => {
    render(<CostReportView />);
    await waitFor(() => { expect(calls.history).toBeTruthy(); });
    const first = calls.history[0] as Record<string, unknown>;
    expect(first.isSubagent).toBeUndefined();
    expect(first.accountName).toBeUndefined();
    expect(String(first.startDate)).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('sends isSubagent when the scope toggle is used', async () => {
    render(<CostReportView />);
    await waitFor(() => { expect(calls.history).toBeTruthy(); });
    // 'Subagents' is both a scope button and a row label in the split table.
    fireEvent.click(screen.getByRole('button', { name: 'Subagents' }));
    await waitFor(() => {
      const last = calls.history[calls.history.length - 1] as Record<string, unknown>;
      expect(last.isSubagent).toBe(true);
    });
  });

  it('passes the project search through as a filter', async () => {
    render(<CostReportView />);
    await waitFor(() => { expect(calls.byProject).toBeTruthy(); });
    fireEvent.change(screen.getByPlaceholderText('Search projects…'), { target: { value: 'mango' } });
    await waitFor(() => {
      const last = calls.byProject[calls.byProject.length - 1] as Record<string, unknown>;
      expect(last.projectSearch).toBe('mango');
    });
  });

  it('names the top project and its share', async () => {
    render(<CostReportView />);
    // The name appears in the by-project sentence AND in its table row.
    await waitFor(() => {
      expect(screen.getAllByText(/personal\/omnifex/).length).toBeGreaterThan(1);
    });
    // 700 of 900 = 78%
    expect(screen.getAllByText('78%').length).toBeGreaterThan(0);
  });

  // Ported from the (deleted) Usage dashboard: requests and sessions answer
  // different questions and neither substitutes for the other.
  it('reports distinct session counts alongside requests', async () => {
    render(<CostReportView />);
    await waitFor(() => { expect(screen.getAllByText('Sessions').length).toBeGreaterThan(0); });
    expect(screen.getByText('42')).toBeTruthy();     // distinct sessions
    expect(screen.getByText('6,600')).toBeTruthy();  // requests
  });

  // A Max plan is not billed per token, so its dollar figure is what the usage
  // WOULD have cost. Printing it unqualified reads as money spent.
  it('marks the total as notional when a subscription account is in scope', async () => {
    render(<CostReportView />);
    await waitFor(() => { expect(screen.getByText('Total (notional)')).toBeTruthy(); });
    expect(screen.getByText(/not a bill/)).toBeTruthy();
    expect(screen.getByText(/Personal is a subscription account/)).toBeTruthy();
  });

  it('drops the notional caveat once only billed accounts are selected', async () => {
    render(<CostReportView />);
    await waitFor(() => { expect(screen.getByText('Total (notional)')).toBeTruthy(); });
    fireEvent.click(screen.getByTestId('account-picker-trigger'));
    fireEvent.click(screen.getByTestId('account-option-Work'));
    await waitFor(() => { expect(screen.queryByText('Total (notional)')).toBeNull(); });
    expect(screen.getByText('Total')).toBeTruthy();
  });

  it('remembers the account filter across a remount, but not the date range', async () => {
    const { unmount } = render(<CostReportView />);
    await waitFor(() => { expect(calls.history).toBeTruthy(); });
    fireEvent.click(screen.getByTestId('account-picker-trigger'));
    fireEvent.click(screen.getByTestId('account-option-Work'));
    fireEvent.click(screen.getByText('All time'));
    await waitFor(() => {
      const last = calls.history[calls.history.length - 1] as Record<string, unknown>;
      expect(last.accountName).toEqual(['Work']);
      expect(last.startDate).toBeUndefined();
    });
    unmount();

    render(<CostReportView />);
    await waitFor(() => {
      const last = calls.history[calls.history.length - 1] as Record<string, unknown>;
      expect(last.accountName).toEqual(['Work']);
      // Range resets, so a stale absolute window can never strand the page.
      expect(String(last.startDate)).toMatch(/^\d{4}-\d{2}-01$/);
    });
  });

  it('renders no unpriced banner when everything is priced', async () => {
    render(<CostReportView />);
    await waitFor(() => { expect(calls.unpriced).toBeTruthy(); });
    expect(screen.queryByText(/billed at the fallback rate/)).toBeNull();
  });
});
