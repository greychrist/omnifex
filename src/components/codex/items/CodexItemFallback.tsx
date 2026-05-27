import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import type { AgentMessage } from "@/lib/api";

/**
 * Extract the `method` discriminator off a Codex notification envelope,
 * returning `"unknown"` when absent so the header always renders a
 * readable label.
 */
function getMethod(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown";
  const method = (payload as { method?: unknown }).method;
  return typeof method === "string" ? method : "unknown";
}

/**
 * Best-effort JSON pretty-print for the raw payload pane. Failures
 * (circular refs, BigInt) fall back to `String(value)` so the fallback
 * never throws — its only job is to keep unknown payloads visible.
 */
function formatPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/**
 * Fallback widget for Codex notification methods the dispatch table
 * doesn't recognize. Renders a warning header with the unknown method
 * name plus the full raw payload in a collapsed `<details>` block, and
 * console-warns once per render so unfamiliar items show up in the Log
 * tab as the protocol drifts.
 *
 * Deliberately visible (not silent): a Codex CLI bump that adds a new
 * `item.*` method should surface as a yellow warning card in dev, not as
 * a missing transcript entry.
 */
export function CodexItemFallback({ message }: { message: AgentMessage }): JSX.Element {
  const method = getMethod(message.payload);
  const warnedRef = useRef(false);

  useEffect(() => {
    if (warnedRef.current) return;
    warnedRef.current = true;
    console.warn(`[codex] unknown notification method: ${method}`);
  }, [method]);

  return (
    <div
      data-codex-item="fallback"
      className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 overflow-hidden"
    >
      <div className="px-4 py-2 flex items-center gap-2 border-b border-yellow-500/20">
        <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
        <span className="text-xs font-medium text-yellow-600 dark:text-yellow-400">
          Unknown Codex item: <code className="font-mono">{method}</code>
        </span>
      </div>
      <div className="p-3">
        <details className="rounded-md border bg-background overflow-hidden">
          <summary className="px-3 py-1.5 text-xs font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/50">
            raw payload
          </summary>
          <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto border-t">
            {formatPayload(message.payload)}
          </pre>
        </details>
      </div>
    </div>
  );
}
