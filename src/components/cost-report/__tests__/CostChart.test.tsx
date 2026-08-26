// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { CostChart, CostChartLegend } from '../CostChart';
import type { CostHistoryPeriodModel } from '@/lib/api';
import { modelColor } from '@/lib/costChartPalette';

function row(period: string, model: string, cost_usd: number): CostHistoryPeriodModel {
  return {
    period, model, cost_usd,
    request_count: 0, input_tokens: 0, output_tokens: 0,
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

  it('paints each model in its fixed slot colour, not by series order', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="dark" />);
    const fills = new Set(
      [...container.querySelectorAll('path[fill]')].map((p) => p.getAttribute('fill')),
    );
    expect(fills.has(modelColor('claude-opus-5', 'dark'))).toBe(true);
    expect(fills.has(modelColor('claude-sonnet-5', 'dark'))).toBe(true);
    expect(fills.has(modelColor('claude-haiku-4-5', 'dark'))).toBe(true);
  });

  it('separates stacked segments with a surface-coloured seam, not a border', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="dark" />);
    const bar = [...container.querySelectorAll('path[fill]')].find((p) =>
      p.getAttribute('fill') === modelColor('claude-opus-5', 'dark'),
    );
    expect(bar?.getAttribute('stroke')).toBe('#1a1a19');
  });

  it('uses the light surface for the seam in light mode', () => {
    const { container } = renderChart(<CostChart rows={ROWS} mode="light" />);
    const bar = [...container.querySelectorAll('path[fill]')].find((p) =>
      p.getAttribute('fill') === modelColor('claude-opus-5', 'light'),
    );
    expect(bar?.getAttribute('stroke')).toBe('#fcfcfb');
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
