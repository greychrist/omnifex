import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentMessage } from "@/lib/api";
import type { JSX } from 'react';

// Codex builds vary: `summary`, `content`, or both; each view falls back to the other.
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

const SUMMARY_PREVIEW_LIMIT = 120;

function truncate(s: string, limit: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? oneLine.slice(0, limit - 1) + "…" : oneLine;
}

// Not ThinkingWidget: sharing its accent slot would leak Codex theming into Claude's appearance settings.
export function AgentReasoningItem({ message }: { message: AgentMessage }): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const { summary, content } = extractReasoning(message.payload);

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
