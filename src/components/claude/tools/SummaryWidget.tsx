import React from "react";
import {
  Info,
} from "lucide-react";

/**
 * Widget for AI-generated summaries
 */
export const SummaryWidget: React.FC<{
  summary: string;
  leafUuid?: string;
}> = ({ summary, leafUuid }) => {
  return (
    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 overflow-hidden">
      <div className="px-4 py-3 flex items-start gap-3">
        <div className="mt-0.5">
          <div className="h-8 w-8 rounded-full bg-blue-500/10 flex items-center justify-center">
            <Info className="h-4 w-4 text-blue-500" />
          </div>
        </div>
        <div className="flex-1 space-y-1">
          <div className="text-xs font-medium text-blue-600 dark:text-blue-400">AI Summary</div>
          <p className="text-sm text-foreground">{summary}</p>
          {leafUuid && (
            <div className="text-xs text-muted-foreground mt-2">
              ID: <code className="font-mono">{leafUuid.slice(0, 8)}...</code>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
