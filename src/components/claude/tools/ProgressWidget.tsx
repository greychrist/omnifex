import React from "react";
import { ListChecks } from "lucide-react";
import type { StepProgress } from "@/lib/stepProgress";

/**
 * A call to the bundled OmniFex mod's progress tool (`mcp__omnifex__progress`)
 * by the main session: the step it reached, as one quiet line. The tool's
 * answer is a no-op, so there is no result to show.
 */
export const ProgressWidget: React.FC<{ progress: StepProgress }> = ({ progress }) => (
  <div
    data-progress-widget
    className="flex items-center gap-2 text-xs text-muted-foreground"
  >
    <ListChecks className="h-3.5 w-3.5 shrink-0" />
    <span>Progress</span>
    <span className="font-mono tabular-nums text-foreground/80">
      {progress.done}/{progress.total}
    </span>
    {progress.note && <span className="truncate">— {progress.note}</span>}
  </div>
);
