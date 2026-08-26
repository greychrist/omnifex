import { useMemo } from 'react';
import {
  Area,
  AreaChart,
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
import { fmtUsd } from '@/lib/costReportFilters';

interface CostChartProps {
  rows: CostHistoryPeriodModel[];
  mode: ChartMode;
}

/**
 * Stacked area of spend over time, one band per model.
 *
 * Model → colour comes from the fixed slot map, never from series order, so
 * filtering a model out does not repaint the survivors and two months' charts
 * stay comparable. Series are also sorted by slot, so the stack order and the
 * legend order agree.
 */
export function CostChart({ rows, mode }: CostChartProps) {
  const { data, models } = useMemo(() => {
    const modelSet = [...new Set(rows.map((r) => r.model))].sort(compareModelsBySlot);
    const byPeriod = new Map<string, Record<string, number | string>>();
    for (const r of rows) {
      let bucket = byPeriod.get(r.period);
      if (!bucket) {
        bucket = { period: r.period };
        // Zero-fill every series, or recharts renders a gap where a model was
        // simply unused that day and the stack visibly tears.
        for (const m of modelSet) bucket[m] = 0;
        byPeriod.set(r.period, bucket);
      }
      bucket[r.model] = (bucket[r.model] as number) + r.cost_usd;
    }
    return {
      data: [...byPeriod.values()].sort((a, b) => String(a.period).localeCompare(String(b.period))),
      models: modelSet,
    };
  }, [rows]);

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
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
            width={52}
            tickFormatter={(v: number) => fmtUsd(v)}
          />
          <Tooltip
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
            <Area
              key={m}
              type="monotone"
              dataKey={m}
              stackId="cost"
              fill={modelColor(m, mode)}
              fillOpacity={0.9}
              // A 2px surface-coloured seam between stacked bands rather than a
              // same-hue outline: adjacent slots clear the CVD threshold on the
              // adjacent-pair list, and the gap is what keeps them separable.
              stroke={surface}
              strokeWidth={2}
              activeDot={{ r: 4, stroke: surface, strokeWidth: 2 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Legend for the chart — identity is never colour-alone, so every band is
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
