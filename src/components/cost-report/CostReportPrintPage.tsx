// The Cost Report, rendered for PDF export.
//
// This is what a hidden window boots into when the renderer is loaded with a
// `#print=cost-report&…` hash. It is the same `CostReportView` the user sees,
// in print mode — same components, same theme, so the PDF looks like the page.
// What it adds is the handshake: the main process cannot know when a report
// made of eleven independent queries and an SVG chart has finished drawing, so
// this page measures itself and says so.
//
// See `electron/services/cost-report-pdf.ts` for the other half.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppFontProvider } from '@/contexts/AppFontContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { AccountsProvider } from '@/contexts/AccountsContext';
import { CostReportView } from '@/components/CostReportView';
import type { CostFilterState } from '@/lib/costReportFilters';
import { measurePrintContent, type PrintMeasurement } from '@/lib/costReportPrintMeasure';

export interface CostReportPrintPageProps {
  filters: CostFilterState;
  /** Reports the measured page. Injected so the measuring logic can be tested
   *  without an Electron window on the other end. */
  onReady: (measurement: PrintMeasurement) => void;
  /** Overrides for the settle timings, so tests need not wait real seconds. */
  timings?: { chartPollMs?: number; chartTimeoutMs?: number };
}

export function CostReportPrintPage({ filters, onReady, timings }: CostReportPrintPageProps) {
  const [settled, setSettled] = useState<{ chartExpected: boolean } | null>(null);
  const reported = useRef(false);

  const handleSettled = useCallback((info: { chartExpected: boolean }) => {
    setSettled((prev) => prev ?? info);
  }, []);

  useEffect(() => {
    if (!settled || reported.current) return;
    reported.current = true;
    let cancelled = false;

    void measurePrintContent({
      chartExpected: settled.chartExpected,
      pollMs: timings?.chartPollMs,
      timeoutMs: timings?.chartTimeoutMs,
    }).then((measurement) => {
      if (!cancelled) onReady(measurement);
    });

    return () => {
      cancelled = true;
    };
  }, [settled, onReady, timings]);

  return (
    <AppFontProvider>
      <ThemeProvider>
        <AccountsProvider>
          <CostReportView printMode initialFilters={filters} onSettled={handleSettled} />
        </AccountsProvider>
      </ThemeProvider>
    </AppFontProvider>
  );
}
