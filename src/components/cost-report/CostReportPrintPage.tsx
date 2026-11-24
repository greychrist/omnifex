// The daemon can't tell when the report's queries and chart have drawn, so this page measures itself and reports
// ready. Other half: daemon/services/cost-report-pdf.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppFontProvider } from '@/contexts/AppFontContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { AccountsProvider } from '@/contexts/AccountsContext';
import { CostReportView } from '@/components/CostReportView';
import type { CostFilterState } from '@/lib/costReportFilters';
import { measurePrintContent, type PrintMeasurement } from '@/lib/costReportPrintMeasure';

export interface CostReportPrintPageProps {
  filters: CostFilterState;
  onReady: (measurement: PrintMeasurement) => void;
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
