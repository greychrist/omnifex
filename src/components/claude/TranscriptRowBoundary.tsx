import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Containment for a single transcript row.
 *
 * The field-level guards in `StreamMessage` cover the malformed tool inputs we
 * know about; this covers the ones we don't. Without it the nearest boundary
 * above a message is the app-level one in `main.tsx`, so one unrenderable block
 * blanks all of OmniFex — and blanks it again on every replay of that session's
 * JSONL, which is the same `--resume` symptom Claude Code 2.1.229 fixed for
 * itself when a tool call carried a non-string `glob` / `file_path` / `command`.
 *
 * Deliberately quieter than the default `ErrorBoundary` card: a row is one item
 * in a long scroll, so the notice stays inline and the rest of the conversation
 * keeps reading normally. No "Try again" — a message that fails to render is
 * fixed data, and re-rendering it just throws again.
 */
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
