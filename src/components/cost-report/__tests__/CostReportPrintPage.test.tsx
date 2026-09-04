// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { emptyFilterState } from '@/lib/costFilterState';

// The chart needs a layout box jsdom will not give it; its own tests cover the
// drawing. What matters here is the handshake around it.
vi.mock('@/components/cost-report/CostChart', () => ({
  CostChart: () => <div data-testid="chart" />,
  CostChartLegend: () => <div data-testid="legend" />,
}));

vi.mock('@/contexts/AppFontContext', () => ({
  AppFontProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useThemeContext: () => ({ theme: 'gray', setTheme: vi.fn(), isLoading: false }),
}));
vi.mock('@/contexts/AccountsContext', () => ({
  AccountsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAccounts: () => ({
    accounts: [{ id: 1, name: 'Work', subscription_label: 'Enterprise' }],
    refresh: vi.fn(),
    getColor: () => '#3b82f6',
    getIcon: () => null,
    getAccountType: () => 'Enterprise',
  }),
}));
vi.mock('@/hooks', () => ({ useTheme: () => ({ theme: 'gray' }) }));

const { periods } = vi.hoisted(() => ({ periods: { rows: [] as unknown[] } }));

vi.mock('@/lib/api', () => {
  const empty = () => Promise.resolve([]);
  return {
    api: {
      modelPricingList: empty,
      sessionCostHistoryByModel: () => Promise.resolve(periods.rows),
      sessionCostByProject: empty,
      sessionCostByModel: empty,
      sessionCostByProjectModel: empty,
      sessionCostComponents: () => Promise.resolve(null),
      sessionCostCachingRoi: () => Promise.resolve(null),
      sessionCostSubagentSplit: empty,
      sessionCostUnpriced: empty,
      sessionCostSessions: empty,
      sessionCostFacets: () => Promise.resolve(null),
      sessionCostTotals: () => Promise.resolve(null),
    },
  };
});

import { CostReportPrintPage } from '../CostReportPrintPage';

describe('CostReportPrintPage', () => {
  beforeEach(() => {
    periods.rows = [];
    window.localStorage.clear();
    document.body.innerHTML = '';
  });
  afterEach(cleanup);

  const timings = { chartPollMs: 2, chartTimeoutMs: 20 };

  it('reports the measured page once the report has drawn', async () => {
    // This report is the only thing standing between the main process and a
    // PDF of a half-drawn page.
    const onReady = vi.fn();
    render(
      <CostReportPrintPage filters={emptyFilterState()} onReady={onReady} timings={timings} />,
    );

    await waitFor(() => { expect(onReady).toHaveBeenCalled(); });
    const m = onReady.mock.calls[0][0];
    expect(m).toMatchObject({ chartExpected: false });
    expect(typeof m.widthPx).toBe('number');
    expect(typeof m.heightPx).toBe('number');
  });

  it('reports exactly once, however many times the report re-renders', async () => {
    // The export resolves on the first report. A second one would arrive
    // after its window is gone, and land on whatever export ran next.
    const onReady = vi.fn();
    const { rerender } = render(
      <CostReportPrintPage filters={emptyFilterState()} onReady={onReady} timings={timings} />,
    );
    await waitFor(() => { expect(onReady).toHaveBeenCalled(); });

    rerender(
      <CostReportPrintPage filters={emptyFilterState()} onReady={onReady} timings={timings} />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('says a chart is expected when the range actually has spend to plot', async () => {
    periods.rows = [
      { period: '2026-08-01', model: 'claude-opus-5', cost_usd: 5, request_count: 1, session_count: 1, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0, is_estimated: 0 },
    ];
    const onReady = vi.fn();
    render(
      <CostReportPrintPage filters={emptyFilterState()} onReady={onReady} timings={timings} />,
    );

    await waitFor(() => { expect(onReady).toHaveBeenCalled(); });
    expect(onReady.mock.calls[0][0].chartExpected).toBe(true);
  });

  it('renders the report itself, not the app shell', async () => {
    render(
      <CostReportPrintPage filters={emptyFilterState()} onReady={vi.fn()} timings={timings} />,
    );
    expect(await screen.findByTestId('print-caption')).toBeTruthy();
    // The filter bar and the export button are app chrome, not report content.
    expect(screen.queryByTestId('cost-filters')).toBeNull();
    expect(screen.queryByTestId('export-pdf')).toBeNull();
  });
});
