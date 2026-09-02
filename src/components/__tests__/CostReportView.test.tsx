// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';

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
const { calls, record, failing, facetProjects, recordFresh } = vi.hoisted(() => {
  const calls: Record<string, unknown[]> = {};
  /** Mutable so a test can shrink the project facet the way selecting an
   *  account does, and assert the page drops a now-unavailable selection. */
  const facetProjects: string[] = [];
  /** Channels forced to reject, by recorder name. Lets a test simulate one
   *  query failing while the rest succeed. */
  const failing = new Set<string>();
  const record = <T,>(name: string, value: T) => (params: unknown) => {
    (calls[name] ??= []).push(params);
    return failing.has(name)
      ? Promise.reject(new Error(`No handler registered for '${name}'`))
      : Promise.resolve(value);
  };
  /** Like `record`, but builds the value fresh per call. Real IPC returns a
   *  new object every time; a shared one is referentially stable, so React
   *  never sees the state change and effects keyed on it never re-run. */
  const recordFresh = <T,>(name: string, build: () => T) => (params: unknown) => {
    (calls[name] ??= []).push(params);
    return Promise.resolve(build());
  };
  return { calls, record, failing, facetProjects, recordFresh };
});

vi.mock('@/lib/api', () => ({
  api: {
    // The model_pricing delta layer. Empty here — these tests assert against
    // the shipped labels and colours, so an override would only obscure them.
    modelPricingList: vi.fn(async () => []),
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
    sessionCostFacets: recordFresh('facets', () => ({
      accounts: ['Personal', 'Work'], models: ['claude-opus-5', 'claude-sonnet-5'],
      projects: [...facetProjects],
      minDate: '2026-06-10', maxDate: '2026-08-26',
    })),
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
    failing.clear();
    facetProjects.length = 0;
    facetProjects.push('/Users/me/Repos/personal/omnifex', '/Users/me/Repos/work/mango');
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

  /**
   * One query failing must not blank the page. This is exactly what happened
   * in dev: the renderer hot-reloaded and started calling a channel the
   * still-running main process had no handler for, and `Promise.all` turned
   * one missing handler into eleven empty panels.
   */
  describe('partial failure', () => {
    it('keeps every other panel when one query fails', async () => {
      failing.add('totals');
      render(<CostReportView />);

      // The component split, ROI and subagent panels all still render.
      await waitFor(() => { expect(screen.getByText(/of spend is/)).toBeTruthy(); });
      expect(screen.getAllByText('40:1').length).toBeGreaterThan(0);
      expect(screen.getByText(/per request against/)).toBeTruthy();
    });

    it('names the part that failed instead of a bare error', async () => {
      failing.add('totals');
      render(<CostReportView />);
      await waitFor(() => { expect(screen.getByText(/Some panels could not load/)).toBeTruthy(); });
      expect(screen.getByText(/totals/)).toBeTruthy();
    });

    it('still shows the chart when only the totals query fails', async () => {
      failing.add('totals');
      render(<CostReportView />);
      await waitFor(() => { expect(screen.getByTestId('chart')).toBeTruthy(); });
      expect(screen.getByTestId('chart').textContent).toBe('2 rows');
    });

    it('reports every failed query, not just the first', async () => {
      failing.add('totals');
      failing.add('roi');
      render(<CostReportView />);
      await waitFor(() => { expect(screen.getByText(/Some panels could not load/)).toBeTruthy(); });
      const banner = screen.getByText(/Some panels could not load/).textContent ?? '';
      expect(banner).toContain('totals');
      expect(banner).toContain('caching ROI');
    });

    it('shows no failure banner when everything succeeds', async () => {
      render(<CostReportView />);
      await waitFor(() => { expect(screen.getByText(/of spend is/)).toBeTruthy(); });
      expect(screen.queryByText(/Some panels could not load/)).toBeNull();
    });
  });

  it('renders no unpriced banner when everything is priced', async () => {
    render(<CostReportView />);
    await waitFor(() => { expect(calls.unpriced).toBeTruthy(); });
    expect(screen.queryByText(/billed at the fallback rate/)).toBeNull();
  });

  // ── Filter layout ────────────────────────────────────────────────────────
  //
  // The filter bar was one long unlabelled flex-wrap row separated by bare
  // `|` dividers: you had to already know what each control did. These tests
  // pin the grouping so a later tidy-up can't quietly flatten it back.
  describe('filter layout', () => {
    it('labels each filter group', async () => {
      render(<CostReportView />);
      await waitFor(() => { expect(calls.facets).toBeTruthy(); });
      expect(screen.getByText('Date range')).toBeTruthy();
      expect(screen.getByText('Account & project')).toBeTruthy();
      expect(screen.getByText('Model & scope')).toBeTruthy();
    });

    it('puts the account chooser above the date range', async () => {
      render(<CostReportView />);
      await waitFor(() => { expect(calls.facets).toBeTruthy(); });
      const accounts = screen.getByTestId('filter-accounts');
      const dates = screen.getByTestId('filter-date-range');
      // Node.DOCUMENT_POSITION_FOLLOWING === 4
      expect(accounts.compareDocumentPosition(dates) & 4).toBeTruthy();
    });

    it('puts each control in exactly one card', async () => {
      render(<CostReportView />);
      await waitFor(() => { expect(calls.facets).toBeTruthy(); });
      const accountProject = screen.getByTestId('filter-accounts');
      const dates = screen.getByTestId('filter-date-range');
      const modelScope = screen.getByTestId('filter-model-scope');

      // Projects sit with accounts, not with models — they are one question.
      expect(within(accountProject).getByRole('button', { name: /projects/i })).toBeTruthy();
      expect(within(dates).getByRole('button', { name: 'This month' })).toBeTruthy();
      expect(within(modelScope).getByRole('button', { name: 'Main loop' })).toBeTruthy();
      expect(within(modelScope).getByRole('button', { name: /models/i })).toBeTruthy();

      expect(within(dates).queryByRole('button', { name: /models/i })).toBeNull();
      expect(within(modelScope).queryByRole('button', { name: 'This month' })).toBeNull();
    });

    it('offers only this month, last month and all time as presets', async () => {
      render(<CostReportView />);
      await waitFor(() => { expect(calls.facets).toBeTruthy(); });
      const dates = screen.getByTestId('filter-date-range');
      expect(within(dates).queryByText('30 days')).toBeNull();
      expect(within(dates).queryByText('90 days')).toBeNull();
      expect(within(dates).getByText('All time')).toBeTruthy();
    });

    it('has no project search box', async () => {
      render(<CostReportView />);
      await waitFor(() => { expect(calls.facets).toBeTruthy(); });
      expect(screen.queryByPlaceholderText('Search projects…')).toBeNull();
    });

    // The project list narrows with the account, so a selection made under a
    // different account would otherwise keep filtering invisibly.
    it('drops a selected project the account scope no longer offers', async () => {
      render(<CostReportView />);
      await waitFor(() => { expect(calls.byProject).toBeTruthy(); });

      const card = screen.getByTestId('filter-accounts');
      fireEvent.click(within(card).getByRole('button', { name: /projects/i }));
      // 'work/mango' is also a row in the by-project table, so stay in the card.
      fireEvent.click(within(card).getByText('work/mango'));
      await waitFor(() => {
        const last = calls.byProject[calls.byProject.length - 1] as { projectPath?: string[] };
        expect(last.projectPath).toEqual(['/Users/me/Repos/work/mango']);
      });

      // Facets now come back without that project, as they would once an
      // account that does not own it is selected.
      facetProjects.length = 0;
      facetProjects.push('/Users/me/Repos/personal/omnifex');
      fireEvent.click(within(card).getByTestId('account-picker-trigger'));
      fireEvent.click(within(card).getByTestId('account-option-Personal'));

      await waitFor(() => {
        const last = calls.byProject[calls.byProject.length - 1] as { projectPath?: string[] };
        expect(last.projectPath).toBeUndefined();
      });
    });

    it('moves the day/week/month grouping out of the filters and next to the chart', async () => {
      render(<CostReportView />);
      await waitFor(() => { expect(screen.getByTestId('chart')).toBeTruthy(); });

      // It is a display control, not a filter, so it must not sit in the
      // filter block — grouping by week does not change which rows are counted.
      const filters = screen.getByTestId('cost-filters');
      expect(within(filters).queryByTestId('group-by-week')).toBeNull();

      const trend = screen.getByTestId('trend-panel');
      expect(within(trend).getByTestId('group-by-week')).toBeTruthy();
      expect(within(trend).getByTestId('group-by-day')).toBeTruthy();
      expect(within(trend).getByTestId('group-by-month')).toBeTruthy();
    });

    // The bars beneath it are labelled 8/1, 8/2 — spelling the same days out
    // as 2026-08-01 in the sentence makes the reader translate between two
    // formats to find the day being named.
    it('names the heaviest days in the same month/day form as the axis', async () => {
      render(<CostReportView />);
      const trend = await screen.findByTestId('trend-panel');
      await waitFor(() => { expect(within(trend).getByText(/heaviest/)).toBeTruthy(); });
      expect(within(trend).getByText('8/1, 8/2')).toBeTruthy();
      expect(within(trend).queryByText(/2026-08-01/)).toBeNull();
    });

    it('still re-queries when the grouping changes', async () => {
      render(<CostReportView />);
      await waitFor(() => { expect(screen.getByTestId('chart')).toBeTruthy(); });
      fireEvent.click(screen.getByTestId('group-by-week'));
      await waitFor(() => {
        const last = calls.history[calls.history.length - 1] as { groupBy?: string };
        expect(last.groupBy).toBe('week');
      });
    });
  });
});
