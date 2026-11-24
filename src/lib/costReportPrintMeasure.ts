// The PDF is printed at exactly the measured height: a wrong number clips or pads it.

export interface PrintMeasurement {
  widthPx: number;
  heightPx: number;
  chartExpected: boolean;
  chartRendered: boolean;
}

const PRINT_ROOT = '[data-print-root]';

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

  // After the chart settles: its sizing is itself a layout change.
  const root = document.querySelector(PRINT_ROOT);
  const box = root ?? document.documentElement;

  return {
    widthPx: box.scrollWidth,
    heightPx: box.scrollHeight,
    chartExpected: opts.chartExpected,
    chartRendered,
  };
}

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
