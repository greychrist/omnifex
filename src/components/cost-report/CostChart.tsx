import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { CostHistoryPeriodModel } from '@/lib/api';
import {
  compareModelsBySlot,
  modelColor,
  modelLabel,
  type ChartMode,
} from '@/lib/costChartPalette';
import {
  segmentPath,
  toStackedSeries,
  topModelFor,
  type StackedBucket,
} from '@/lib/costChartData';
import { fmtUsd } from '@/lib/costReportFilters';

interface CostChartProps {
  rows: CostHistoryPeriodModel[];
  mode: ChartMode;
}

/** 4px rounded data-end — a column's cap, top corners only. */
const CAP_RADIUS = 4;

/** Segment separation is a gap in the surface colour, not a border drawn round
 *  the mark. 1px each side reads as the 2px gap the method asks for. */
const SEAM = 1;

/**
 * Stacked columns of spend over time, one segment per model.
 *
 * Bars rather than an area: this is part-to-whole across discrete periods, and
 * an area implies the spend interpolates between days, which it does not.
 *
 * Model → colour comes from the fixed slot map, never from series order, so
 * filtering a model out does not repaint the survivors and two months' charts
 * stay comparable. Series are sorted by slot too, so stack order and legend
 * order agree.
 */
export function CostChart({ rows, mode }: CostChartProps) {
  const { data, models } = useMemo(() => toStackedSeries(rows), [rows]);

  const axis = mode === 'dark' ? '#898781' : '#52514e';
  const grid = mode === 'dark' ? '#2c2c2a' : '#e1e0d9';
  const surface = mode === 'dark' ? '#1a1a19' : '#fcfcfb';

  if (data.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-xs text-muted-foreground">
        No spend in this range.
      </div>
    );
  }

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
          <CartesianGrid stroke={grid} vertical={false} />
          <XAxis
            dataKey="period"
            stroke={axis}
            tick={{ fontSize: 10, fill: axis }}
            tickLine={false}
            axisLine={{ stroke: grid }}
            minTickGap={24}
          />
          <YAxis
            stroke={axis}
            tick={{ fontSize: 10, fill: axis }}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => fmtUsd(v)}
          />
          <Tooltip
            cursor={{ fill: mode === 'dark' ? '#ffffff12' : '#0000000a' }}
            contentStyle={{
              background: surface,
              border: `1px solid ${grid}`,
              borderRadius: 6,
              fontSize: 11,
            }}
            labelStyle={{ color: axis }}
            formatter={(value, name) => [fmtUsd(Number(value ?? 0)), modelLabel(String(name))]}
          />
          {models.map((m) => (
            <Bar
              key={m}
              dataKey={m}
              stackId="cost"
              fill={modelColor(m, mode)}
              stroke={surface}
              strokeWidth={SEAM}
              isAnimationActive={false}
              // Which model sits on top varies per period, so the cap radius is
              // decided per cell rather than per series.
              shape={(props: unknown) => (
                <StackedSegment {...(props as SegmentProps)} models={models} />
              )}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface SegmentProps {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  dataKey: string;
  payload: StackedBucket;
}

/** One stacked segment, rounding its top corners only when it is the topmost
 *  segment that actually renders in its period. */
function StackedSegment({ models, ...p }: SegmentProps & { models: string[] }) {
  const isTop = topModelFor(p.payload, models) === p.dataKey;
  const d = segmentPath(p.x, p.y, p.width, p.height, isTop ? CAP_RADIUS : 0);
  if (!d) return null;
  return <path d={d} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth} />;
}

/** Legend for the chart — identity is never colour-alone, so every segment is
 *  also named here and in the by-model table below it. */
export function CostChartLegend({ models, mode }: { models: string[]; mode: ChartMode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {[...models].sort(compareModelsBySlot).map((m) => (
        <span key={m} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: modelColor(m, mode) }}
            aria-hidden
          />
          {modelLabel(m)}
        </span>
      ))}
    </div>
  );
}
