// Cost Report — the filter state itself: its shape, its defaults, and how a
// date preset resolves to a window.
//
// Split from costReportFilters.ts because this half has to be importable from
// the MAIN process (the PDF export encodes filter state into the print
// window's URL). That means no `@/` path aliases and no DOM: the electron
// tsconfig configures neither, and the main bundle would pull in the whole
// renderer API surface behind them. costReportFilters.ts re-exports all of
// this, so nothing in the renderer needs to know it moved.

export type RangeKey = 'month' | 'last-month' | 'all';

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
  scope: CostScope;
  groupBy: 'day' | 'week' | 'month';
}

/** Three presets, on one line. The rolling 30/90-day windows were dropped:
 *  they answered the same question as "this month" less precisely, and the
 *  explicit from/to inputs below cover any window worth naming. */
export const RANGE_PRESETS: Array<{ key: RangeKey; label: string }> = [
  { key: 'month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
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
  // Unreachable given RangeKey, but exhaustiveness here is what makes adding
  // a preset later a compile error rather than a silently empty range.
  return { startDate: undefined, endDate: undefined };
}
