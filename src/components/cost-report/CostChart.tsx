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
  byTier,
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
  pricing?: readonly ModelPricingInput[];
}

const SEAM = 1;

// From theme tokens, not hex: the three themes' card colors differ too much for one fixed value.
const PLOT_SURFACE: Record<ChartMode, string> = {
  dark: 'color-mix(in oklab, var(--color-card), white 6%)',
  light: 'var(--color-background)',
};

/** Below the gridlines, which recharts pins at -100. */
const PLOT_SURFACE_Z = -200;

const RULE: Record<ChartMode, string> = {
  dark: 'color-mix(in oklab, var(--color-card), white 28%)',
  light: 'color-mix(in oklab, var(--color-card), black 10%)',
};

// Model → color from the fixed slot map, never series order: filtering a model must not repaint the rest.
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
              // The top model varies per period, so the cap radius is decided per cell.
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

function WeekSeparators({ periods, stroke }: { periods: string[]; stroke: string }) {
  const plotArea = usePlotArea();
  const xScale = useXAxisScale();
  if (!plotArea || !xScale) return null;
  return (
    <g className="recharts-week-separators">
      {weekBoundaries(periods).map((period) => {
        const x = xScale(period, { position: 'start' });
        if (x === undefined) return null;
        // Half-pixel offset: on an integer coordinate a 1px line smears across two device pixels.
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

function StackedSegment({ models, ...p }: SegmentProps & { models: string[] }) {
  const radius = capRadius(p.width);
  const value = Number(p.payload[p.dataKey] ?? 0);
  const pxPerUnit = value > 0 ? p.height / value : 0;
  const isTop = topCappedModel(p.payload, models, pxPerUnit, radius) === p.dataKey;
  const d = segmentPath(p.x, p.y, p.width, p.height, isTop ? radius : 0);
  if (!d) return null;
  return <path d={d} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth} />;
}

export function CostChartLegend(
  { models, mode, pricing }: { models: string[]; mode: ChartMode; pricing?: readonly ModelPricingInput[] },
) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {[...models].sort(byTier(pricing)).map((m) => (
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
