import { describe, it, expect, vi } from 'vitest';
import {
  createCostReportPdfService,
  type CostReportPdfDeps,
  type PrintWindowLike,
} from '../services/cost-report-pdf';
import { emptyFilterState } from '../../src/lib/costFilterState';
import { MAX_PDF_INCHES } from '../../src/lib/costReportPrint';

const PDF = Buffer.from('%PDF-1.7 fake');

function fakeWindow(over: Partial<PrintWindowLike> = {}): PrintWindowLike {
  let destroyed = false;
  return {
    webContentsId: 42,
    printToPDF: vi.fn().mockResolvedValue(PDF),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    isDestroyed: () => destroyed,
    ...over,
  };
}

/** A service wired to fakes, plus handles on them. `ready` fires the renderer's
 *  "I have painted" report, which is what unblocks the export. */
function setup(over: Partial<CostReportPdfDeps> = {}) {
  const win = fakeWindow();
  const writeFile = vi.fn().mockResolvedValue(undefined);
  const load = vi.fn().mockResolvedValue(undefined);
  const warn = vi.fn();
  const deps: CostReportPdfDeps = {
    createWindow: vi.fn(() => win),
    load,
    writeFile,
    warn,
    readyTimeoutMs: 50,
    ...over,
  };
  const service = createCostReportPdfService(deps);
  const ready = (metrics: Partial<Parameters<typeof service.reportReady>[1]> = {}) =>
    service.reportReady(win.webContentsId, {
      widthPx: 1152,
      heightPx: 4800,
      chartExpected: true,
      chartRendered: true,
      ...metrics,
    });
  return { service, win, writeFile, load, warn, deps, ready };
}

const params = () => ({ filters: emptyFilterState(), savePath: '/tmp/report.pdf' });

describe('cost report PDF export', () => {
  it('writes the printed PDF to the requested path', async () => {
    const { service, writeFile, ready } = setup();
    const done = service.exportPdf(params());
    await vi.waitFor(() => expect(service.pendingCount()).toBe(1));
    ready();

    await expect(done).resolves.toEqual({ path: '/tmp/report.pdf' });
    expect(writeFile).toHaveBeenCalledWith('/tmp/report.pdf', PDF);
  });

  it('sizes the page from the measurement the renderer reported', async () => {
    // The whole point of waiting for the renderer: the page is exactly as
    // tall as the laid-out report. A guess here is a PDF that clips or has a
    // slab of empty space at the bottom.
    const { service, win, ready } = setup();
    const done = service.exportPdf(params());
    await vi.waitFor(() => expect(service.pendingCount()).toBe(1));
    ready({ widthPx: 1152, heightPx: 4800 });
    await done;

    const opts = vi.mocked(win.printToPDF).mock.calls[0][0];
    expect(opts.pageSize).toEqual({ width: 12, height: 50 });
    expect(opts.scale).toBe(1);
    // Screenshot-faithful means the dark theme has to survive; without this
    // the PDF prints as black text on white and looks nothing like the page.
    expect(opts.printBackground).toBe(true);
    expect(opts.margins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it('scales an over-long report to fit rather than truncating it', async () => {
    const { service, win, ready } = setup();
    const done = service.exportPdf(params());
    await vi.waitFor(() => expect(service.pendingCount()).toBe(1));
    ready({ heightPx: MAX_PDF_INCHES * 96 * 2 });
    await done;

    const opts = vi.mocked(win.printToPDF).mock.calls[0][0];
    expect(opts.scale).toBeCloseTo(0.5, 6);
    expect(opts.pageSize.height).toBeCloseTo(MAX_PDF_INCHES, 6);
  });

  it('carries the filter state into the window it loads', async () => {
    const { service, load, ready } = setup();
    const filters = { ...emptyFilterState(), rangeKey: 'last-month' as const, scope: 'subagent' as const };
    const done = service.exportPdf({ filters, savePath: '/tmp/x.pdf' });
    await vi.waitFor(() => expect(service.pendingCount()).toBe(1));
    ready();
    await done;

    const hash = vi.mocked(load).mock.calls[0][1];
    expect(hash).toContain('print=cost-report');
    expect(hash).toContain('rangeKey=last-month');
    expect(hash).toContain('scope=subagent');
  });

  it('destroys the print window after a successful export', async () => {
    const { service, win, ready } = setup();
    const done = service.exportPdf(params());
    await vi.waitFor(() => expect(service.pendingCount()).toBe(1));
    ready();
    await done;

    expect(win.destroy).toHaveBeenCalled();
    expect(service.pendingCount()).toBe(0);
  });

  it('destroys the print window when printing fails', async () => {
    // A hidden window that outlives a failed export is invisible and holds a
    // renderer process forever. It has to die on every path.
    const win = fakeWindow({ printToPDF: vi.fn().mockRejectedValue(new Error('boom')) });
    const { service, ready } = setup({ createWindow: () => win });
    const done = service.exportPdf(params());
    await vi.waitFor(() => expect(service.pendingCount()).toBe(1));
    ready();

    await expect(done).rejects.toThrow('boom');
    expect(win.destroy).toHaveBeenCalled();
    expect(service.pendingCount()).toBe(0);
  });

  it('destroys the print window when the load fails', async () => {
    const win = fakeWindow();
    const { service } = setup({
      createWindow: () => win,
      load: vi.fn().mockRejectedValue(new Error('load failed')),
    });

    await expect(service.exportPdf(params())).rejects.toThrow('load failed');
    expect(win.destroy).toHaveBeenCalled();
    expect(service.pendingCount()).toBe(0);
  });

  it('leaves no armed timer behind when an export fails before the wait', async () => {
    // A load that rejects never reaches the `await`, so the ready deadline is
    // abandoned mid-flight. Left armed it holds the event loop open for the
    // whole timeout and then rejects a promise nobody is holding — an
    // unhandled rejection blamed on an export that already failed for an
    // unrelated reason.
    vi.useFakeTimers();
    try {
      const { service } = setup({
        readyTimeoutMs: 30_000,
        load: vi.fn().mockRejectedValue(new Error('load failed')),
      });

      await expect(service.exportPdf(params())).rejects.toThrow('load failed');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails with a legible error when the renderer never reports ready', async () => {
    // Printing anyway would emit a half-painted or empty PDF, which looks
    // like a successful export until someone opens it.
    const { service, win } = setup({ readyTimeoutMs: 10 });

    await expect(service.exportPdf(params())).rejects.toThrow(/never finished rendering/i);
    expect(win.printToPDF).not.toHaveBeenCalled();
    expect(win.destroy).toHaveBeenCalled();
    expect(service.pendingCount()).toBe(0);
  });

  it('warns, but still exports, when a chart was expected and did not render', async () => {
    // recharts sizes itself from a ResizeObserver, which is the one thing
    // about rendering in a hidden window that could plausibly not work. Every
    // export checks it rather than trusting a one-time manual verification.
    const { service, warn, ready } = setup();
    const done = service.exportPdf(params());
    await vi.waitFor(() => expect(service.pendingCount()).toBe(1));
    ready({ chartExpected: true, chartRendered: false });

    await expect(done).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/chart/i));
  });

  it('does not warn when the report legitimately has no chart to draw', async () => {
    const { service, warn, ready } = setup();
    const done = service.exportPdf(params());
    await vi.waitFor(() => expect(service.pendingCount()).toBe(1));
    ready({ chartExpected: false, chartRendered: false });
    await done;

    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a ready report from a window it is not waiting on', async () => {
    // Two exports in flight, or a stale window reporting late, must not
    // resolve the wrong export with the wrong measurements.
    const { service, ready } = setup({ readyTimeoutMs: 30 });
    const done = service.exportPdf(params());
    await vi.waitFor(() => expect(service.pendingCount()).toBe(1));

    service.reportReady(999, {
      widthPx: 1, heightPx: 1, chartExpected: false, chartRendered: false,
    });
    await expect(done).rejects.toThrow(/never finished rendering/i);

    // The real one would still have been accepted.
    expect(typeof ready).toBe('function');
  });
});
