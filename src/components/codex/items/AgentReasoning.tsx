import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentMessage } from "@/lib/api";

/**
 * Extracts the reasoning text from an `agent_reasoning` notification.
 *
 * Wire shape (Codex builds vary):
 *   { method: "agent_reasoning", params: { summary?: string, content?: string } }
 *
 * Some builds send only `summary` (a short headline), some send both, and
 * some have shipped `text` instead. We surface both fields independently so
 * the collapsed header can show the short summary while the expanded body
 * shows the full content. When only one is present, both views fall back
 * to it.
 */
function extractReasoning(payload: unknown): { summary: string; content: string } {
  if (!payload || typeof payload !== "object") return { summary: "", content: "" };
  const params = (payload as { params?: unknown }).params;
  if (!params || typeof params !== "object") return { summary: "", content: "" };
  const p = params as { summary?: unknown; content?: unknown; text?: unknown };
  const summary = typeof p.summary === "string" ? p.summary : "";
  const content =
    typeof p.content === "string" ? p.content
      : typeof p.text === "string" ? p.text
        : "";
  return { summary, content };
}

/** Collapsed-header inline preview length. Long single-line summaries get
 *  truncated so the trigger row stays a single line. */
const SUMMARY_PREVIEW_LIMIT = 120;

function truncate(s: string, limit: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? oneLine.slice(0, limit - 1) + "…" : oneLine;
}

/**
 * Renders a Codex `agent_reasoning` notification as a collapsible
 * "Thinking…" card. Collapsed by default — matches Claude's
 * `ThinkingWidget` behavior (assistant reasoning is supplementary; the
 * user opts in by clicking the header).
 *
 * Deliberately not reusing `ThinkingWidget` itself: that component is
 * wired to Claude's `assistant.thinking` accent style in the message
 * rendering config (custom icon, color, header label). Codex reasoning
 * is a parallel concept, not the same kind — sharing the accent slot
 * would leak Codex theming into Claude's appearance settings.
 */
export function AgentReasoningItem({ message }: { message: AgentMessage }): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const { summary, content } = extractReasoning(message.payload);

  // Prefer `content` for the expanded body; fall back to `summary` so a
  // payload with only one field still reveals something on click.
  const fullText = (content || summary).trim();
  const headerPreview = truncate(summary || content, SUMMARY_PREVIEW_LIMIT);

  return (
    <div
      data-codex-item="agent_reasoning"
      className="rounded-lg border border-border/40 bg-muted/20 overflow-hidden"
    >
      <button
        type="button"
        onClick={() => { setIsExpanded((v) => !v); }}
        aria-expanded={isExpanded}
        className="w-full px-4 py-2.5 flex items-center justify-between gap-2 transition-colors hover:bg-muted/40"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-semibold italic text-muted-foreground shrink-0">
            Thinking…
          </span>
          {headerPreview && !isExpanded && (
            <span className="text-xs text-muted-foreground/80 truncate">
              {headerPreview}
            </span>
          )}
        </div>
        <ChevronRight
          className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", isExpanded && "rotate-90")}
        />
      </button>

      {isExpanded && (
        <div className="px-4 pb-3 pt-1 border-t border-border/40">
          <pre className="text-xs font-mono whitespace-pre-wrap italic text-muted-foreground">
            {fullText}
          </pre>
        </div>
      )}
    </div>
  );
}
