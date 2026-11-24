const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK = /^(\d{4})-W(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const MAX_TICKS = 31;

const MS_PER_DAY = 86_400_000;

/** UTC throughout: period keys are calendar strings and must not shift with the local zone. */
function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Monday: SQLite's `%W` grouping uses it, so separators agree with the week buckets. */
function mondayOf(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  return toIsoDate(ms - dow * MS_PER_DAY);
}

/** Week 00 is the partial week before the year's first Monday and starts on January 1st. */
export function weekStartDate(period: string): string | null {
  const m = WEEK.exec(period);
  if (!m) return null;
  const week = Number(m[2]);
  const jan1 = Date.parse(`${m[1]}-01-01T00:00:00Z`);
  if (week === 0) return toIsoDate(jan1);
  const jan1Dow = (new Date(jan1).getUTCDay() + 6) % 7;
  const firstMonday = jan1 + ((7 - jan1Dow) % 7) * MS_PER_DAY;
  return toIsoDate(firstMonday + (week - 1) * 7 * MS_PER_DAY);
}

export function formatPeriodTick(period: string): string {
  const day = DAY.exec(period);
  if (day) return `${Number(day[2])}/${Number(day[3])}`;

  const weekStart = weekStartDate(period);
  if (weekStart) return formatPeriodTick(weekStart);

  const month = MONTH.exec(period);
  if (month) return MONTH_NAMES[Number(month[2]) - 1] ?? period;

  return period;
}

/** Keyed on the containing Monday: a week with no Monday spend still has a first bar. */
export function weekBoundaries(periods: string[]): string[] {
  const out: string[] = [];
  let previous: string | null = null;
  for (const period of periods) {
    if (!DAY.test(period)) return [];
    const week = mondayOf(period);
    if (previous !== null && week !== previous) out.push(period);
    previous = week;
  }
  return out;
}

/** Thins ticks evenly: recharts' `minTickGap` culls unevenly, which reads as missing days. */
export function tickInterval(count: number, maxTicks: number = MAX_TICKS): number {
  if (count <= maxTicks) return 0;
  return Math.ceil(count / maxTicks) - 1;
}
