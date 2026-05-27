import type { AgentMessage } from "@/lib/api";

/**
 * Fallback widget for Codex notification methods the dispatch table
 * doesn't recognize. Renders a minimal envelope so unfamiliar items are
 * visible (not silently dropped) while the dispatch table catches up
 * with upstream Codex protocol additions.
 */
export function CodexItemFallback({ message }: { message: AgentMessage }): JSX.Element {
  const method =
    message.payload && typeof message.payload === "object" && "method" in message.payload
      ? String((message.payload as { method?: unknown }).method ?? "unknown")
      : "unknown";
  return <div data-codex-item="fallback">codex: {method}</div>;
}
