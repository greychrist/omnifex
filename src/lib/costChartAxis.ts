// Cost Report chart — turning period keys into axis ticks and week markers.
//
// Pure and separate from the component for the same reason costChartData is:
// recharts needs a real layout box, so the shaping is what gets tested.

/** Period keys as `aggregateByModel` emits them, one shape per groupBy. */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK = /^(\d{4})-W(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Ticks the x-axis can hold side by side at 10px before they collide. */
const MAX_TICKS = 31;

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` for a UTC timestamp. Dates are handled in UTC throughout: the
 *  period keys are calendar strings and must not shift with the local zone. */
function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Monday of the week containing `date`, as `YYYY-MM-DD`.
 *
 *  Monday because that is what SQLite's `%W` grouping uses; a Sunday-based
 *  week here would draw separators that disagree with the week buckets the
 *  same page shows one button away. */
function mondayOf(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  // getUTCDay is Sunday=0; shift so Monday=0.
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  return toIsoDate(ms - dow * MS_PER_DAY);
}

/**
 * The Monday that opens a `%Y-W%W` week, or null if the period isn't a week.
 *
 * Week 01 starts on the year's first Monday, so week N starts N-1 weeks after
 * it. Week 00 is the partial week before that first Monday and starts on
 * January 1st — the one case where the arithmetic doesn't apply.
 */
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

/**
 * The axis label for a period key.
 *
 * The year is dropped: every bar on screen is inside the selected range, so
 * repeating `2026-` on all 31 ticks spends the width that stops them
 * colliding and tells the reader nothing. The tooltip still carries the full
 * period.
 */
export function formatPeriodTick(period: string): string {
  const day = DAY.exec(period);
  if (day) return `${Number(day[2])}/${Number(day[3])}`;

  const weekStart = weekStartDate(period);
  if (weekStart) return formatPeriodTick(weekStart);

  const month = MONTH.exec(period);
  if (month) return MONTH_NAMES[Number(month[2]) - 1] ?? period;

  return period;
}

/**
 * The periods that open a new week, for drawing week separators — empty
 * unless the periods are days, since week and month buckets are already one
 * bar per period.
 *
 * Keyed on the containing Monday rather than "is this a Monday?": a week with
 * no spend on its Monday still has a first bar, and that bar belongs on the
 * far side of the line.
 *
 * The first period is never a boundary; the axis is already the edge there.
 */
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

/**
 * recharts' `interval` for the x-axis: 0 labels every bar, n skips n between
 * labels.
 *
 * Every bar gets a label whenever they fit, which for a month of days they
 * do. Past that the ticks thin evenly rather than colliding — recharts' own
 * `minTickGap` culling would drop them unevenly, which reads as missing days.
 */
export function tickInterval(count: number, maxTicks: number = MAX_TICKS): number {
  if (count <= maxTicks) return 0;
  return Math.ceil(count / maxTicks) - 1;
}
