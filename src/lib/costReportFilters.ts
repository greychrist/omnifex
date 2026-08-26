// Cost Report — filter state and formatting, kept pure and out of the view.
//
// The filter bar's state is the single source of truth for every panel on the
// page, so the state → query-params mapping is the one place a bug would show
// up as "two panels disagree about what they're showing". It lives here, with
// tests, rather than inline in the component.

import type { CostHistoryFilterParams } from '@/lib/api';

export type RangeKey = 'month' | 'last-month' | '30d' | '90d' | 'all';

/** Which side of the Task boundary to count. */
export type CostScope = 'all' | 'main' | 'subagent';

export interface CostFilterState {
  rangeKey: RangeKey;
  /** Explicit dates beat the preset — see `toFilterParams`. */
  customStart: string;
  customEnd: string;
  accounts: string[];
  models: string[];
  projects: string[];
  projectSearch: string;
  scope: CostScope;
  groupBy: 'day' | 'week' | 'month';
}

export const RANGE_PRESETS: Array<{ key: RangeKey; label: string }> = [
  { key: 'month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
];

export function emptyFilterState(): CostFilterState {
  return {
    rangeKey: 'month',
    customStart: '',
    customEnd: '',
    accounts: [],
    models: [],
    projects: [],
    projectSearch: '',
    scope: 'all',
    groupBy: 'day',
  };
}

/** Today in UTC — the basis `session_cost_daily.date` is bucketed on. Passing
 *  it in keeps this module pure and the tests free of clock mocking. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function resolveRange(
  key: RangeKey,
  today: string,
): { startDate: string | undefined; endDate: string | undefined } {
  if (key === 'all') return { startDate: undefined, endDate: undefined };
  if (key === 'month') return { startDate: `${today.slice(0, 7)}-01`, endDate: undefined };
  if (key === 'last-month') {
    const firstOfThis = `${today.slice(0, 7)}-01`;
    // One day before this month's 1st is the last day of the previous month —
    // no month-length or year-boundary arithmetic to get wrong.
    const endDate = shiftDays(firstOfThis, -1);
    return { startDate: `${endDate.slice(0, 7)}-01`, endDate };
  }
  return { startDate: shiftDays(today, key === '30d' ? -30 : -90), endDate: undefined };
}

/**
 * Filter state → the shape every cost query takes.
 *
 * Empty multi-selects are omitted rather than sent as `[]`. The service reads
 * an empty array as "no filter" too, but omitting keeps the IPC payload honest
 * about what the user actually chose.
 *
 * A custom date beats the preset. The alternative — preset wins — makes typing
 * a start date look like it did nothing.
 */
export function toFilterParams(state: CostFilterState, today: string): CostHistoryFilterParams {
  const preset = resolveRange(state.rangeKey, today);
  const params: CostHistoryFilterParams = {};

  const startDate = state.customStart || preset.startDate;
  const endDate = state.customEnd || preset.endDate;
  if (startDate) params.startDate = startDate;
  if (endDate) params.endDate = endDate;

  if (state.accounts.length) params.accountName = state.accounts;
  if (state.models.length) params.model = state.models;
  if (state.projects.length) params.projectPath = state.projects;

  const search = state.projectSearch.trim();
  if (search) params.projectSearch = search;

  if (state.scope !== 'all') params.isSubagent = state.scope === 'subagent';

  return params;
}

/** Sub-cent figures matter here — a $0.0031 per-request cost rounded to $0.00
 *  is the whole subagent-efficiency finding erased. */
export function fmtUsd(v: number): string {
  if (v !== 0 && Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Reads as a ratio because that is what it is; a bare `35.4` invites being
 *  mistaken for a dollar figure in a table full of them. */
export function fmtRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '—';
  return ratio >= 10 ? `${Math.round(ratio)}:1` : `${ratio.toFixed(1)}:1`;
}
