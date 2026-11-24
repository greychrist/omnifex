import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/** Per-row boundary: otherwise one bad block blanks the app on every replay. No retry: a row that fails to render throws again. */
export function TranscriptRowBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={(error) => (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-destructive/80 mt-0.5" />
          <div className="min-w-0 space-y-1">
            <div>This message couldn't be rendered.</div>
            {error.message && (
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] opacity-70">
                {error.message}
              </pre>
            )}
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
