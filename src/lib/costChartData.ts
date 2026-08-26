// Cost Report chart — pivoting period × model rows into stacked-bar buckets.
//
// Pure and separate from the component: recharts needs a real layout box, so a
// jsdom test of the chart itself proves nothing. The shaping is where the bugs
// would be, so it lives here where it can be tested directly.

import type { CostHistoryPeriodModel } from '@/lib/api';
import { compareModelsBySlot } from '@/lib/costChartPalette';

/** One period's bucket: the period label plus one numeric key per model. */
export type StackedBucket = { period: string } & Record<string, string | number>;

/**
 * Pivot `[{period, model, cost_usd}]` into one row per period with a key per
 * model, ordered chronologically, with models in fixed slot order so the stack
 * order matches the legend.
 *
 * Every series is zero-filled in every period. Leaving a key undefined makes
 * recharts skip the segment, which tears the stack wherever a model simply
 * wasn't used that day.
 */
export function toStackedSeries(rows: CostHistoryPeriodModel[]): {
  data: StackedBucket[];
  models: string[];
} {
  if (rows.length === 0) return { data: [], models: [] };

  const models = [...new Set(rows.map((r) => r.model))].sort(compareModelsBySlot);
  const byPeriod = new Map<string, StackedBucket>();

  for (const r of rows) {
    let bucket = byPeriod.get(r.period);
    if (!bucket) {
      bucket = { period: r.period };
      for (const m of models) bucket[m] = 0;
      byPeriod.set(r.period, bucket);
    }
    // Accumulate rather than assign: the query groups by period+model, but a
    // caller that hands us pre-split rows must not silently lose one.
    bucket[r.model] = (bucket[r.model] as number) + r.cost_usd;
  }

  return {
    data: [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period)),
    models,
  };
}

/**
 * The topmost model that actually renders in this period — the last one in
 * stack order with a non-zero value, or null when the period has no spend.
 *
 * Only the top of a stack is a data-end, so only it takes the 4px round.
 * Rounding every segment would make interior joins read as separate bars; and
 * rounding a zeroed series (which draws nothing) would leave the visible top
 * square.
 */
export function topModelFor(bucket: StackedBucket, models: string[]): string | null {
  for (let i = models.length - 1; i >= 0; i -= 1) {
    if ((bucket[models[i]] as number) > 0) return models[i];
  }
  return null;
}

/**
 * SVG path for one stacked column segment, with the top corners rounded by
 * `radius` and the bottom left square (it either sits on the baseline or on
 * the segment below).
 *
 * The radius is clamped to the segment's own size. A 4px round on a 3px-tall
 * rect inverts the arc and renders as a notch out of the bar — the reason this
 * is a tested function rather than three inline template literals.
 */
export function segmentPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  if (!(width > 0) || !(height > 0)) return '';
  const r = Math.max(0, Math.min(radius, width / 2, height));
  if (r === 0) return `M${x},${y}h${width}v${height}h${-width}Z`;
  return (
    `M${x},${y + r}` +
    `a${r},${r} 0 0 1 ${r},${-r}` +
    `h${width - 2 * r}` +
    `a${r},${r} 0 0 1 ${r},${r}` +
    `v${height - r}` +
    `h${-width}Z`
  );
}
