import { buildPrintHash, pdfPageSize } from '../../src/lib/costReportPrint';
import type { CostFilterState } from '../../src/lib/costFilterState';

/**
 * Cost Report → PDF.
 *
 * The report is rendered a second time in a hidden window and that window is
 * printed to PDF, rather than printing the visible one. The live report sits
 * inside `h-screen` / `overflow-hidden` / `h-full overflow-auto` wrappers, so
 * the on-screen document is exactly one window tall — printing it yields one
 * screenful, not the report. Unwrapping those constraints on a live React tree
 * is where content silently disappears; a second window lays the same
 * components out unclipped and cannot disturb what the user is looking at.
 *
 * Every Electron and filesystem touch is injected, so the orchestration —
 * which is where the mistakes live — is testable in plain Node.
 */

/** The renderer's report that it has finished painting, with what to print. */
export interface PrintMetrics {
  /** Laid-out content box, in CSS pixels. */
  widthPx: number;
  heightPx: number;
  /** Whether this report has a chart at all (an empty range draws none). */
  chartExpected: boolean;
  /** Whether that chart actually got a size. See `warn` below. */
  chartRendered: boolean;
}

/** The slice of `BrowserWindow` this service uses. */
export interface PrintWindowLike {
  webContentsId: number;
  printToPDF(options: {
    pageSize: { width: number; height: number };
    scale: number;
    printBackground: boolean;
    margins: { top: number; bottom: number; left: number; right: number };
  }): Promise<Buffer>;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface CostReportPdfDeps {
  createWindow(): PrintWindowLike;
  /** Load the renderer into `window` at `hash` (dev server URL or file). */
  load(window: PrintWindowLike, hash: string): Promise<void>;
  writeFile(path: string, data: Buffer): Promise<void>;
  warn(message: string): void;
  /** How long to wait for the renderer's ready report. */
  readyTimeoutMs?: number;
}

export interface CostReportPdfService {
  exportPdf(params: { filters: CostFilterState; savePath: string }): Promise<{ path: string }>;
  /** Called by the IPC handler when a print window reports it has painted. */
  reportReady(webContentsId: number, metrics: PrintMetrics): void;
  /** Exports waiting on a renderer right now. Test seam. */
  pendingCount(): number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

export function createCostReportPdfService(deps: CostReportPdfDeps): CostReportPdfService {
  const timeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  /** webContents id → the export waiting on that window. Keyed on the id and
   *  not on "the one in flight" so a late report from a torn-down window
   *  cannot resolve a different export with the wrong measurements. */
  const pending = new Map<number, (metrics: PrintMetrics) => void>();

  /**
   * The renderer's ready report, with a hard deadline.
   *
   * Returns a `cancel` alongside the promise because the wait can be abandoned
   * — a load that rejects never reaches the `await`. Without cancelling, the
   * timer stays armed for the full timeout, holds the event loop open, and
   * eventually rejects a promise nobody is holding: an unhandled rejection
   * attributed to an export that already failed for an unrelated reason.
   */
  function waitForReady(webContentsId: number): {
    promise: Promise<PrintMetrics>;
    cancel(): void;
  } {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<PrintMetrics>((resolve, reject) => {
      timer = setTimeout(() => {
        pending.delete(webContentsId);
        reject(
          new Error(
            'Cost report PDF: the report never finished rendering. Nothing was written — ' +
            'a PDF printed at this point would be blank or half-drawn.',
          ),
        );
      }, timeoutMs);

      pending.set(webContentsId, (metrics) => {
        clearTimeout(timer);
        pending.delete(webContentsId);
        resolve(metrics);
      });
    });

    return {
      promise,
      cancel: () => {
        clearTimeout(timer);
        pending.delete(webContentsId);
        // The promise may already be rejected-but-unobserved at this point.
        // Claiming it here is what keeps that from surfacing as an unhandled
        // rejection in a process that is otherwise fine.
        promise.catch(() => {});
      },
    };
  }

  async function exportPdf(params: {
    filters: CostFilterState;
    savePath: string;
  }): Promise<{ path: string }> {
    const window = deps.createWindow();
    const ready = waitForReady(window.webContentsId);
    try {
      await deps.load(window, buildPrintHash(params.filters));
      const metrics = await ready.promise;

      if (metrics.chartExpected && !metrics.chartRendered) {
        // recharts' ResponsiveContainer sizes itself from a ResizeObserver,
        // the one part of rendering offscreen that could plausibly not fire.
        // Checked on every export rather than trusted from a one-off manual
        // check, so a regression surfaces as a log line and not as a blank
        // panel nobody notices.
        deps.warn(
          'Cost report PDF: the spend chart reported no size before printing — ' +
          'the chart panel in this PDF may be blank.',
        );
      }

      const { pageSize, scale } = pdfPageSize(metrics);
      const pdf = await window.printToPDF({
        pageSize,
        scale,
        printBackground: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      await deps.writeFile(params.savePath, pdf);
      return { path: params.savePath };
    } finally {
      ready.cancel();
      // A hidden window that outlives a failed export is invisible and holds
      // a renderer process for the life of the app.
      if (!window.isDestroyed()) window.destroy();
    }
  }

  return {
    exportPdf,
    reportReady(webContentsId, metrics) {
      pending.get(webContentsId)?.(metrics);
    },
    pendingCount: () => pending.size,
  };
}
