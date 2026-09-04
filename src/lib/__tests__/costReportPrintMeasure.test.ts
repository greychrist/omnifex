// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { measurePrintContent } from '@/lib/costReportPrintMeasure';

/** Build a print root of a given size, optionally containing a chart surface
 *  whose width appears after `appearsAfterMs`. */
function mountRoot(opts: {
  width: number;
  height: number;
  chart?: { width: number; appearsAfterMs?: number };
}) {
  const root = document.createElement('div');
  root.setAttribute('data-print-root', '');
  Object.defineProperty(root, 'scrollWidth', { value: opts.width, configurable: true });
  Object.defineProperty(root, 'scrollHeight', { value: opts.height, configurable: true });
  document.body.appendChild(root);

  if (opts.chart) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('recharts-surface');
    let width = opts.chart.appearsAfterMs ? 0 : opts.chart.width;
    if (opts.chart.appearsAfterMs) {
      setTimeout(() => { width = opts.chart!.width; }, opts.chart.appearsAfterMs);
    }
    // getBoundingClientRect is what jsdom stubs to zero; drive it off the
    // closure so the width can appear partway through the poll.
    svg.getBoundingClientRect = () => ({ width, height: 224 }) as DOMRect;
    root.appendChild(svg);
  }
  return root;
}

describe('measurePrintContent', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => { vi.useRealTimers(); });

  it('measures the print root, not the window', async () => {
    // The window is a fixed size; the report is however tall it is. Measuring
    // the window is exactly the bug this whole path exists to avoid.
    mountRoot({ width: 1152, height: 7321 });
    const m = await measurePrintContent({ chartExpected: false });
    expect(m.widthPx).toBe(1152);
    expect(m.heightPx).toBe(7321);
  });

  it('reports the chart as rendered once it has a width', async () => {
    mountRoot({ width: 1152, height: 4000, chart: { width: 1040 } });
    const m = await measurePrintContent({ chartExpected: true });
    expect(m.chartExpected).toBe(true);
    expect(m.chartRendered).toBe(true);
  });

  it('waits for a chart that sizes itself late', async () => {
    // recharts' ResponsiveContainer measures via ResizeObserver, so the SVG
    // exists at zero width for a frame or two before it gets its box. Giving
    // up immediately would report every chart as broken.
    mountRoot({ width: 1152, height: 4000, chart: { width: 1040, appearsAfterMs: 40 } });
    const m = await measurePrintContent({ chartExpected: true, pollMs: 5, timeoutMs: 500 });
    expect(m.chartRendered).toBe(true);
  });

  it('gives up on a chart that never sizes, rather than hanging the export', async () => {
    // A hung measurement is a hung export and a hidden window that never
    // closes. Reporting chartRendered:false lets the export finish and log.
    mountRoot({ width: 1152, height: 4000, chart: { width: 0 } });
    const m = await measurePrintContent({ chartExpected: true, pollMs: 5, timeoutMs: 30 });
    expect(m.chartRendered).toBe(false);
    expect(m.heightPx).toBe(4000);
  });

  it('does not wait for a chart when the range has none to draw', async () => {
    const started = Date.now();
    mountRoot({ width: 1152, height: 900 });
    const m = await measurePrintContent({ chartExpected: false, pollMs: 5, timeoutMs: 5000 });
    expect(m.chartRendered).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('falls back to the document when the print root is missing', async () => {
    // Should not happen, but a measurement of 0 makes printToPDF emit a
    // zero-size page, which is worse than a slightly-wrong one.
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: 800, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 600, configurable: true });
    const m = await measurePrintContent({ chartExpected: false });
    expect(m.widthPx).toBe(800);
    expect(m.heightPx).toBe(600);
  });
});
