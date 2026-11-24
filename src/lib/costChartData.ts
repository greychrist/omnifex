import type { CostHistoryPeriodModel } from '@/lib/api';
import { compareModels } from '@/lib/costChartPalette';

export type StackedBucket = { period: string } & Record<string, string | number>;

/** Zero-fills every series: an undefined key makes recharts skip the segment and tears the stack. */
export function toStackedSeries(rows: CostHistoryPeriodModel[]): {
  data: StackedBucket[];
  models: string[];
} {
  if (rows.length === 0) return { data: [], models: [] };

  const models = [...new Set(rows.map((r) => r.model))].sort(compareModels);
  const byPeriod = new Map<string, StackedBucket>();

  for (const r of rows) {
    let bucket = byPeriod.get(r.period);
    if (!bucket) {
      bucket = { period: r.period };
      for (const m of models) bucket[m] = 0;
      byPeriod.set(r.period, bucket);
    }
    bucket[r.model] = (bucket[r.model] as number) + r.cost_usd;
  }

  return {
    data: [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period)),
    models,
  };
}

export function topModelFor(bucket: StackedBucket, models: string[]): string | null {
  for (let i = models.length - 1; i >= 0; i -= 1) {
    if ((bucket[models[i]] as number) > 0) return models[i];
  }
  return null;
}

/** Radius clamped to the segment: a 4px round on a 3px rect renders as a notch. */
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

const MAX_CAP_RADIUS = 6;

const CAP_RATIO = 0.3;

export function capRadius(width: number): number {
  if (!(width > 0)) return 0;
  return Math.min(MAX_CAP_RADIUS, Math.round(width * CAP_RATIO));
}

/** Not `topModelFor`: the topmost non-zero segment is often sub-pixel, leaving every visible bar square. */
export function topCappedModel(
  bucket: StackedBucket,
  models: string[],
  pxPerUnit: number,
  minHeight: number,
): string | null {
  if (pxPerUnit > 0) {
    for (let i = models.length - 1; i >= 0; i -= 1) {
      if ((bucket[models[i]] as number) * pxPerUnit >= minHeight) return models[i];
    }
  }
  return topModelFor(bucket, models);
}
