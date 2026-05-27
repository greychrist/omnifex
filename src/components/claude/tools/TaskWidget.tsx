import React from "react";
import { Bot, ListTree } from "lucide-react";

interface Props {
  description?: string;
  prompt?: string;
  subagentType?: string;
  result?: any;
}

/**
 * Card rendered at a Task / Agent tool_use position — the "Subagent
 * spawned" half of the timeline marker pair (the "returned" half is
 * SubagentReturnedMarker rendered at the matching tool_result).
 *
 * Replaces the prior JSON-blob fallback. Header reads "Subagent Prompt:
 * {description}" with subagent_type as a small subtitle, and the prompt
 * text renders directly so users can read it without clicking through.
 */
export const TaskWidget: React.FC<Props> = ({ description, prompt, subagentType }) => {
  return (
    <div className="rounded-md border border-purple-500/30 bg-purple-500/5 p-3 space-y-2">
      <div className="flex items-baseline gap-2">
        <ListTree className="h-3.5 w-3.5 text-purple-500 shrink-0 self-center" />
        <span className="text-sm font-semibold text-purple-600 dark:text-purple-400">
          Subagent Prompt{description ? `: ${description}` : ''}
        </span>
        {subagentType && (
          <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
            <Bot className="inline h-3 w-3 mr-1 -mt-0.5" />
            {subagentType}
          </span>
        )}
      </div>
      {prompt && (
        <pre className="text-xs whitespace-pre-wrap text-foreground/90 font-sans leading-relaxed">
          {prompt}
        </pre>
      )}
    </div>
  );
};
