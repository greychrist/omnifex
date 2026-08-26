import { describe, it, expect } from 'vitest';
import { segmentPath, toStackedSeries, topModelFor } from '../costChartData';
import type { CostHistoryPeriodModel } from '@/lib/api';

function row(period: string, model: string, cost_usd: number): CostHistoryPeriodModel {
  return {
    period, model, cost_usd,
    request_count: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0,
    input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0,
    is_estimated: 0,
  };
}

describe('toStackedSeries', () => {
  it('pivots period × model rows into one bucket per period', () => {
    const { data, models } = toStackedSeries([
      row('2026-08-01', 'claude-opus-5', 10),
      row('2026-08-01', 'claude-sonnet-5', 2),
      row('2026-08-02', 'claude-opus-5', 7),
    ]);
    expect(models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(data).toEqual([
      { period: '2026-08-01', 'claude-opus-5': 10, 'claude-sonnet-5': 2 },
      { period: '2026-08-02', 'claude-opus-5': 7, 'claude-sonnet-5': 0 },
    ]);
  });

  // Without the zero-fill recharts leaves the key undefined and the stack
  // tears where a model simply wasn't used that day.
  it('zero-fills every series in every period', () => {
    const { data } = toStackedSeries([
      row('2026-08-01', 'claude-opus-5', 1),
      row('2026-08-02', 'claude-haiku-4-5', 3),
    ]);
    expect(data[0]['claude-haiku-4-5']).toBe(0);
    expect(data[1]['claude-opus-5']).toBe(0);
  });

  it('orders models by fixed slot, so stack order matches the legend', () => {
    const { models } = toStackedSeries([
      row('2026-08-01', 'claude-sonnet-5', 1),
      row('2026-08-01', 'claude-opus-4-8', 1),
      row('2026-08-01', 'claude-opus-5', 1),
    ]);
    expect(models).toEqual(['claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5']);
  });

  it('orders periods chronologically regardless of input order', () => {
    const { data } = toStackedSeries([
      row('2026-08-03', 'claude-opus-5', 1),
      row('2026-08-01', 'claude-opus-5', 1),
      row('2026-08-02', 'claude-opus-5', 1),
    ]);
    expect(data.map((d) => d.period)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('sums duplicate period+model rows rather than letting the last win', () => {
    const { data } = toStackedSeries([
      row('2026-08-01', 'claude-opus-5', 4),
      row('2026-08-01', 'claude-opus-5', 6),
    ]);
    expect(data[0]['claude-opus-5']).toBe(10);
  });

  it('returns empty for no rows', () => {
    expect(toStackedSeries([])).toEqual({ data: [], models: [] });
  });
});

/**
 * Only the top of a stack is a data-end, so only it gets the 4px round. If
 * every segment were rounded, interior joins would read as separate bars.
 */
describe('topModelFor', () => {
  const models = ['a', 'b', 'c'];

  it('is the last model in stack order with a non-zero value', () => {
    expect(topModelFor({ period: 'p', a: 1, b: 2, c: 3 }, models)).toBe('c');
    expect(topModelFor({ period: 'p', a: 1, b: 2, c: 0 }, models)).toBe('b');
    expect(topModelFor({ period: 'p', a: 1, b: 0, c: 0 }, models)).toBe('a');
  });

  // A zero-height segment draws nothing, so rounding it would leave the
  // visible top square.
  it('skips zeroed series so the round lands on a segment that renders', () => {
    expect(topModelFor({ period: 'p', a: 5, b: 0, c: 0 }, models)).toBe('a');
  });

  it('is null when the period has no spend at all', () => {
    expect(topModelFor({ period: 'p', a: 0, b: 0, c: 0 }, models)).toBeNull();
  });
});

describe('segmentPath', () => {
  it('draws a plain rect when the radius is zero (an interior segment)', () => {
    expect(segmentPath(10, 20, 30, 40, 0)).toBe('M10,20h30v40h-30Z');
  });

  it('rounds only the top corners, leaving the base square', () => {
    const d = segmentPath(0, 0, 20, 50, 4);
    expect(d.startsWith('M0,4')).toBe(true);
    // Two arcs (the two top corners), then straight down and back along the base.
    expect(d.match(/a4,4/g)).toHaveLength(2);
    expect(d.endsWith('h-20Z')).toBe(true);
  });

  // The bug this function exists to prevent: an unclamped 4px round on a 3px
  // segment inverts the arc and renders as a notch cut out of the bar.
  it('clamps the radius to the segment height', () => {
    const d = segmentPath(0, 0, 20, 3, 4);
    expect(d.match(/a3,3/g)).toHaveLength(2);
    expect(d).not.toContain('v-');
  });

  it('clamps the radius to half the width on a narrow segment', () => {
    const d = segmentPath(0, 0, 5, 40, 4);
    expect(d.match(/a2\.5,2\.5/g)).toHaveLength(2);
  });

  // The straight run between the two corner arcs is `width - 2r`. If the
  // radius were not clamped to half the width it would go negative, doubling
  // the path back on itself.
  it('never emits a negative run between the corner arcs, at any size', () => {
    const runBetweenArcs = (d: string): number => Number(/h(-?[\d.]+)a/.exec(d)?.[1] ?? '0');
    for (const w of [1, 2, 3, 5, 8, 13, 40]) {
      for (const h of [1, 2, 4, 9, 100]) {
        expect(runBetweenArcs(segmentPath(0, 0, w, h, 4)), `w=${w} h=${h}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('renders nothing for a zero-height or zero-width segment', () => {
    expect(segmentPath(0, 0, 10, 0, 4)).toBe('');
    expect(segmentPath(0, 0, 0, 10, 4)).toBe('');
  });
});
