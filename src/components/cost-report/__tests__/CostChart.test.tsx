// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { CostChart, CostChartLegend } from '../CostChart';
import type { CostHistoryPeriodModel } from '@/lib/api';
import { modelColor } from '@/lib/costChartPalette';

function row(period: string, model: string, cost_usd: number): CostHistoryPeriodModel {
  return {
    period, model, cost_usd,
    request_count: 0, session_count: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0,
    input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0,
    is_estimated: 0,
  };
}

const ROWS = [
  row('2026-08-01', 'claude-opus-5', 100),
  row('2026-08-01', 'claude-sonnet-5', 20),
  row('2026-08-02', 'claude-opus-5', 60),
  row('2026-08-03', 'claude-haiku-4-5', 5),
];

const W = 800;
const H = 224;

/**
 * recharts' ResponsiveContainer measures its parent through ResizeObserver,
 * which jsdom does not implement — so the chart renders at 0×0 and draws
 * nothing. Stubbing both the observer and the box lets the real SVG render, so
 * the marks below are the ones the app actually draws.
 */
beforeAll(() => {
  class StubResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ target, contentRect: { width: W, height: H } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: W });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: H });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: W });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: H });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: W, height: H, top: 0, left: 0, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}) });
});

function renderChart(ui: React.ReactElement) {
  return render(ui);
}

describe('CostChart', () => {
  afterEach(cleanup);

  it('renders an empty state rather than a blank box when there is no spend', () => {
    const { container } = renderChart(<CostChart rows={[]} mode="dark" />);
    expect(container.textContent).toContain('No spend in this range.');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws one closed bar path per rendered segment', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="dark" />);
    const paths = [...container.querySelectorAll('path')].filter((p) =>
      (p.getAttribute('d') ?? '').startsWith('M'),
    );
    // 4 non-zero segments across 3 periods; zero-filled ones draw nothing.
    const bars = paths.filter((p) => (p.getAttribute('d') ?? '').endsWith('Z'));
    expect(bars.length).toBeGreaterThanOrEqual(4);
    for (const b of bars) {
      // No NaN or Infinity anywhere in the geometry — the failure mode that
      // renders as a blank chart with no error.
      expect(b.getAttribute('d')).not.toMatch(/NaN|Infinity/);
    }
  });

  it('labels every bar with month/day, leaving the year off', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="dark" />);
    const ticks = [...container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value')]
      .map((t) => t.textContent);
    expect(ticks).toEqual(['8/1', '8/2', '8/3']);
  });

  it('rules a line between weeks so week boundaries are visible', () => {
    // 2026-08-03 is a Monday, so the line sits between 8/2 and 8/3.
    const { container } = renderChart(<CostChart rows={ROWS} mode="dark" />);
    const lines = [...container.querySelectorAll('line[data-testid="week-separator"]')];
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(Number(line.getAttribute('x1'))).toBe(Number(line.getAttribute('x2')));
    expect(Number(line.getAttribute('x1'))).toBeGreaterThan(0);
    expect(Number(line.getAttribute('y2'))).toBeGreaterThan(Number(line.getAttribute('y1')));
  });

  it('draws no week separators when the bars are already weeks', () => {
    const weekly = [row('2026-W30', 'claude-opus-5', 10), row('2026-W31', 'claude-opus-5', 8)];
    const { container } = renderChart(<CostChart rows={weekly} mode="dark" />);
    expect(container.querySelectorAll('line[data-testid="week-separator"]')).toHaveLength(0);
  });

  // Gridlines and week rules were a near-black tuned to the old surface; on the
  // lighter plot they vanished into it. They are silver-gray now: a step the
  // reader can see, still recessive against the bars.
  it('rules the grid and the week lines in the same silver, lifted off the plot', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="dark" />);
    const surface = container.querySelector('rect[data-testid="plot-surface"]')?.getAttribute('fill');
    const gridline = container.querySelector('.recharts-cartesian-grid-horizontal line');
    const separator = container.querySelector('line[data-testid="week-separator"]');

    expect(gridline?.getAttribute('stroke')).not.toBe(surface);
    expect(separator?.getAttribute('stroke')).toBe(gridline?.getAttribute('stroke'));
    // Dark mode lifts toward white; the old value was a fixed near-black.
    expect(gridline?.getAttribute('stroke')).toContain('white');
  });

  it('drops the rules toward black in light mode instead of flipping the dark value', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="light" />);
    const gridline = container.querySelector('.recharts-cartesian-grid-horizontal line');
    expect(gridline?.getAttribute('stroke')).toContain('black');
  });

  it('paints each model in its fixed slot colour, not by series order', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="dark" />);
    const fills = new Set(
      [...container.querySelectorAll('path[fill]')].map((p) => p.getAttribute('fill')),
    );
    expect(fills.has(modelColor('claude-opus-5', 'dark'))).toBe(true);
    expect(fills.has(modelColor('claude-sonnet-5', 'dark'))).toBe(true);
    expect(fills.has(modelColor('claude-haiku-4-5', 'dark'))).toBe(true);
  });

  // A fixed radius looked square on a month of narrow bars and vanished on a
  // week of wide ones; it scales with the bar now, capped at 10px.
  it('caps the topmost segment with a round scaled to the bar, top corners only', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="dark" />);
    // Three periods across 800px: bars are wide, so the cap takes the ceiling.
    const caps = [...container.querySelectorAll('path')].filter((p) =>
      (p.getAttribute('d') ?? '').includes('a6,6'),
    );
    expect(caps.length).toBeGreaterThan(0);
    // Two arcs, both at the top, then straight sides down to a square base.
    for (const cap of caps) {
      expect((cap.getAttribute('d')?.match(/a6,6/g) ?? []).length).toBe(2);
    }
  });

  // The bug that made every bar in a real month square: a $0.29 Haiku segment
  // on a $272 Opus bar is the topmost non-zero model and is under a pixel
  // tall, so the cap went to a segment nobody can see.
  it('caps the tallest visible segment when a sub-pixel sliver sits on top', () => {
    const slivered = [
      row('2026-08-01', 'claude-opus-5', 272),
      row('2026-08-01', 'claude-haiku-4-5', 0.29),
      row('2026-08-02', 'claude-opus-5', 180),
      row('2026-08-02', 'claude-haiku-4-5', 0.2),
    ];
    const { container } = renderChart(<CostChart rows={slivered} mode="dark" />);
    const opus = [...container.querySelectorAll('path[fill]')].filter(
      (p) => p.getAttribute('fill') === modelColor('claude-opus-5', 'dark'),
    );
    expect(opus.length).toBe(2);
    for (const bar of opus) {
      expect(bar.getAttribute('d')).toMatch(/a6,6/);
    }
  });

  it('lays a surface behind the plot area, a step lighter than the card', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="dark" />);
    const surface = container.querySelector('rect[data-testid="plot-surface"]');
    expect(surface).toBeTruthy();
    expect(Number(surface?.getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(surface?.getAttribute('height'))).toBeGreaterThan(0);
    // Derived from the card token: three themes ship three different card
    // colours, and a fixed hex is visibly wrong in two of them.
    expect(surface?.getAttribute('fill')).toContain('var(--color-card)');
  });

  it('paints the plot surface from the page background in light mode', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="light" />);
    const surface = container.querySelector('rect[data-testid="plot-surface"]');
    expect(surface?.getAttribute('fill')).toBe('var(--color-background)');
  });

  // The seam is a gap cut in the bar, so it has to be the colour of whatever
  // is behind the bar — now the plot surface, not the card.
  it('separates stacked segments with a seam in the plot surface colour', () => {
    for (const mode of ['dark', 'light'] as const) {
      const { container } = renderChart(<CostChart rows={ROWS} mode={mode} />);
      const surface = container.querySelector('rect[data-testid="plot-surface"]');
      const bar = [...container.querySelectorAll('path[fill]')].find((p) =>
        p.getAttribute('fill') === modelColor('claude-opus-5', mode),
      );
      expect(bar?.getAttribute('stroke')).toBe(surface?.getAttribute('fill'));
      cleanup();
    }
  });
});

describe('CostChartLegend', () => {
  afterEach(cleanup);

  // Identity must never be colour-alone: every band is named, and the names
  // are the human labels rather than raw dated model ids.
  it('names every series with its label and swatch', () => {
    const { container } = render(
      <CostChartLegend models={['claude-haiku-4-5-20251001', 'claude-opus-5']} mode="dark" />,
    );
    expect(container.textContent).toContain('Opus 5');
    expect(container.textContent).toContain('Haiku 4.5');
    expect(container.querySelectorAll('span[aria-hidden]')).toHaveLength(2);
  });

  it('orders the legend by fixed slot, matching the stack order', () => {
    const { container } = render(
      <CostChartLegend models={['claude-sonnet-5', 'claude-opus-4-8']} mode="dark" />,
    );
    expect(container.textContent).toBe('Opus 4.8Sonnet 5');
  });
});
