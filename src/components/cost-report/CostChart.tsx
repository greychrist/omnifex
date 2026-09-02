import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  usePlotArea,
  useXAxisScale,
  XAxis,
  YAxis,
  ZIndexLayer,
} from 'recharts';
import type { CostHistoryPeriodModel } from '@/lib/api';
import {
  bySlot,
  modelColor,
  modelLabel,
  type ChartMode,
} from '@/lib/costChartPalette';
import {
  capRadius,
  segmentPath,
  toStackedSeries,
  topCappedModel,
  type StackedBucket,
} from '@/lib/costChartData';
import { formatPeriodTick, tickInterval, weekBoundaries } from '@/lib/costChartAxis';
import type { ModelPricingInput } from '@/lib/pricing';
import { fmtUsd } from '@/lib/costReportFilters';

interface CostChartProps {
  rows: CostHistoryPeriodModel[];
  mode: ChartMode;
  /** The `model_pricing` delta layer, so a model released after this build
   *  gets its configured legend name and colour instead of a raw id and a
   *  hashed hue. Undefined means "use what shipped". */
  pricing?: readonly ModelPricingInput[];
}

/** Segment separation is a gap in the surface colour, not a border drawn round
 *  the mark. 1px each side reads as the 2px gap the method asks for. */
const SEAM = 1;

/**
 * The plot area sits one step above the card it is on, so the chart reads as
 * an inset panel rather than as ink floating on the panel behind it.
 *
 * Derived from the theme tokens rather than fixed hex: the app ships three
 * themes whose card colours differ by a lot (0.14, 0.23 and 0.96 lightness),
 * and a hex tuned to one of them is visibly wrong in the other two.
 */
const PLOT_SURFACE: Record<ChartMode, string> = {
  dark: 'color-mix(in oklab, var(--color-card), white 6%)',
  // Light's card is already near-white, so a mix barely moves; the page
  // background is the real step above it (0.98 against the card's 0.96).
  light: 'var(--color-background)',
};

/** Below the gridlines, which recharts pins at -100. */
const PLOT_SURFACE_Z = -200;

/**
 * Gridlines, axis line and week rules — one silver-gray for all of the chart's
 * furniture.
 *
 * Same reason as the surface: derived from the card token, because the value
 * has to clear whatever the plot surface underneath it is. The previous fixed
 * near-black was a step off the *old* surface and disappeared into the lighter
 * one. Solid and hairline, never dashed; a dashed rule competes with the marks
 * it is separating.
 */
const RULE: Record<ChartMode, string> = {
  dark: 'color-mix(in oklab, var(--color-card), white 28%)',
  // Light mode is stepped separately, not flipped: its card is near-white, so
  // the rule goes down toward black, and only far enough to land where the
  // previous light gridline already sat.
  light: 'color-mix(in oklab, var(--color-card), black 10%)',
};

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
export function CostChart({ rows, mode, pricing }: CostChartProps) {
  const { data, models } = useMemo(() => toStackedSeries(rows), [rows]);
  const periods = useMemo(() => data.map((d) => d.period), [data]);

  const plot = PLOT_SURFACE[mode];
  const axis = mode === 'dark' ? '#898781' : '#52514e';
  const grid = RULE[mode];
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
          <ZIndexLayer zIndex={PLOT_SURFACE_Z}>
            <PlotSurface fill={plot} />
          </ZIndexLayer>
          <CartesianGrid stroke={grid} vertical={false} />
          <WeekSeparators periods={periods} stroke={grid} />
          <XAxis
            dataKey="period"
            stroke={axis}
            tick={{ fontSize: 10, fill: axis }}
            tickFormatter={formatPeriodTick}
            tickLine={false}
            axisLine={{ stroke: grid }}
            interval={tickInterval(data.length)}
            minTickGap={0}
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
            formatter={(value, name) => [fmtUsd(Number(value ?? 0)), modelLabel(String(name), pricing)]}
          />
          {models.map((m) => (
            <Bar
              key={m}
              dataKey={m}
              stackId="cost"
              fill={modelColor(m, mode, pricing)}
              stroke={plot}
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

/** The lighter panel the bars are drawn on. */
function PlotSurface({ fill }: { fill: string }) {
  const plotArea = usePlotArea();
  if (!plotArea) return null;
  return (
    <rect
      data-testid="plot-surface"
      x={plotArea.x}
      y={plotArea.y}
      width={plotArea.width}
      height={plotArea.height}
      rx={4}
      fill={fill}
    />
  );
}

/**
 * Hairline rules at the week boundaries, so a month of daily bars reads as
 * four weeks rather than thirty-one undifferentiated columns.
 *
 * Drawn before the bars so they sit behind the data, in the gridline gray and
 * solid — a separator is chart furniture, and dashing it would make it
 * compete with the marks it is separating. `position: 'start'` puts the line
 * on the band edge, which is the middle of the gap between two bars.
 *
 * Nothing renders for week or month buckets; `weekBoundaries` returns none.
 */
function WeekSeparators({ periods, stroke }: { periods: string[]; stroke: string }) {
  const plotArea = usePlotArea();
  const xScale = useXAxisScale();
  if (!plotArea || !xScale) return null;
  return (
    <g className="recharts-week-separators">
      {weekBoundaries(periods).map((period) => {
        const x = xScale(period, { position: 'start' });
        if (x === undefined) return null;
        // Half-pixel offset: a 1px line on an integer coordinate straddles two
        // device pixels and renders as a 2px smear.
        const cx = Math.round(x) + 0.5;
        return (
          <line
            key={period}
            data-testid="week-separator"
            x1={cx}
            x2={cx}
            y1={plotArea.y}
            y2={plotArea.y + plotArea.height}
            stroke={stroke}
            strokeWidth={1}
          />
        );
      })}
    </g>
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
 *  segment tall enough to show the round in its period.
 *
 *  The px-per-unit scale is recovered from this segment's own geometry — the
 *  only place a `shape` callback can see it, and it is the same for every
 *  segment in the stack. */
function StackedSegment({ models, ...p }: SegmentProps & { models: string[] }) {
  const radius = capRadius(p.width);
  const value = Number(p.payload[p.dataKey] ?? 0);
  const pxPerUnit = value > 0 ? p.height / value : 0;
  const isTop = topCappedModel(p.payload, models, pxPerUnit, radius) === p.dataKey;
  const d = segmentPath(p.x, p.y, p.width, p.height, isTop ? radius : 0);
  if (!d) return null;
  return <path d={d} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth} />;
}

/** Legend for the chart — identity is never colour-alone, so every segment is
 *  also named here and in the by-model table below it. */
export function CostChartLegend(
  { models, mode, pricing }: { models: string[]; mode: ChartMode; pricing?: readonly ModelPricingInput[] },
) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {[...models].sort(bySlot(pricing)).map((m) => (
        <span key={m} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: modelColor(m, mode, pricing) }}
            aria-hidden
          />
          {modelLabel(m, pricing)}
        </span>
      ))}
    </div>
  );
}
