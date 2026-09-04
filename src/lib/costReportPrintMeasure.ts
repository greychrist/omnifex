// Measuring the print window's report before it is turned into a PDF.
//
// Split out of the print page component because it is the load-bearing part:
// the main process prints a page exactly this tall, so a wrong number here is
// a clipped or padded PDF, and the chart check here is what turns "does
// recharts size itself in a hidden window?" from a one-time manual answer into
// something every export verifies.

/** What the renderer tells the main process once the report has drawn. */
export interface PrintMeasurement {
  widthPx: number;
  heightPx: number;
  chartExpected: boolean;
  chartRendered: boolean;
}

/** Attribute marking the report's content box. Set by `CostReportView` in
 *  print mode; the pair is deliberately in one place each. */
const PRINT_ROOT = '[data-print-root]';

/** recharts paints into this. Its width is the signal we wait on. */
const CHART_SURFACE = '.recharts-surface';

const DEFAULT_POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 4000;

export async function measurePrintContent(opts: {
  chartExpected: boolean;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<PrintMeasurement> {
  const chartRendered = opts.chartExpected
    ? await waitForChart(opts.pollMs ?? DEFAULT_POLL_MS, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    : false;

  // Measured after the chart settles: the chart getting its height is itself
  // a layout change, so measuring first would report a shorter page.
  const root = document.querySelector(PRINT_ROOT);
  const box = root ?? document.documentElement;

  return {
    widthPx: box.scrollWidth,
    heightPx: box.scrollHeight,
    chartExpected: opts.chartExpected,
    chartRendered,
  };
}

/**
 * Resolve once the chart SVG has a non-zero width, or false on timeout.
 *
 * Times out rather than waiting forever: a hung measurement is a hung export
 * and a hidden window that never closes. Reporting `false` lets the export
 * finish and the service log that the panel may be blank — a PDF with one
 * empty panel and a warning beats no PDF and no explanation.
 */
function waitForChart(pollMs: number, timeoutMs: number): Promise<boolean> {
  const hasWidth = () => {
    const svg = document.querySelector(CHART_SURFACE);
    return !!svg && svg.getBoundingClientRect().width > 0;
  };
  if (hasWidth()) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (hasWidth()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, pollMs);
    };
    setTimeout(tick, pollMs);
  });
}
