export type RangeKey = 'month' | 'last-month' | 'all';

export type CostScope = 'all' | 'main' | 'subagent';

export interface CostFilterState {
  rangeKey: RangeKey;
  customStart: string;
  customEnd: string;
  accounts: string[];
  models: string[];
  projects: string[];
  scope: CostScope;
  groupBy: 'day' | 'week' | 'month';
}

export const RANGE_PRESETS: { key: RangeKey; label: string }[] = [
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
    const endDate = shiftDays(firstOfThis, -1);
    return { startDate: `${endDate.slice(0, 7)}-01`, endDate };
  }
  return { startDate: undefined, endDate: undefined };
}
