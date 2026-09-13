import React from "react";
import {
  Terminal,
  ChevronRight,
  GitBranch,
  FilePenLine,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { extractResultContent } from "@/components/claude/tools/shared";
import { parseGitOperation, parseBashEditDiff } from "@/lib/bashToolResult";

/**
 * Widget for Bash tool
 */
export const BashWidget: React.FC<{
  command: string;
  description?: string;
  result?: any;
  /**
   * The structured half of the tool result (`tool_use_result` live,
   * `toolUseResult` on disk) — what the model is not shown. Optional because
   * it is absent until the result lands, and `bashEditDiff` within it is
   * populated only in auto / bypassPermissions sessions.
   */
  structured?: Record<string, unknown>;
}> = ({ command, description, result, structured }) => {
  // Extract result content if available
  let resultContent = '';
  let isError = false;

  if (result) {
    isError = result.is_error || false;
    resultContent = extractResultContent(result);
  }

  const gitOp = parseGitOperation(structured);
  const editDiff = parseBashEditDiff(structured);

  return (
    <div className="rounded-lg border bg-background overflow-hidden">
      <div className="px-4 py-2 bg-muted/50 flex items-center gap-2 border-b">
        <Terminal className="h-3.5 w-3.5 text-green-500" />
        <span className="text-xs font-mono text-muted-foreground">Terminal</span>
        {description && (
          <>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{description}</span>
          </>
        )}
        {/* Show loading indicator when no result yet */}
        {!result && (
          <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            <div className="h-2 w-2 bg-green-500 rounded-full animate-pulse" />
            <span>Running...</span>
          </div>
        )}
      </div>
      <div className="p-4 space-y-3">
        <code className="text-xs font-mono text-green-400 block">
          $ {command}
        </code>

        {/* Show result if available */}
        {result && (
          <div className={cn(
            "mt-3 p-3 rounded-md border text-xs font-mono whitespace-pre-wrap overflow-x-auto",
            isError
              ? "border-red-500/20 bg-red-500/5 text-red-400"
              : "border-green-500/20 bg-green-500/5 text-green-300"
          )}>
            {resultContent || (isError ? "Command failed" : "Command completed")}
          </div>
        )}

        {/*
          What the command did, as the CLI classified it — not re-parsed from
          stdout. Both blocks below are the CLI's own words for its own work.
        */}
        {gitOp && (
          <div className="flex items-center gap-1.5 text-xs">
            <GitBranch className="h-3 w-3 shrink-0 text-blue-400" />
            <span className="text-muted-foreground">{gitOp.label}</span>
            <code className="font-mono text-blue-400 truncate">{gitOp.detail}</code>
          </div>
        )}

        {editDiff && (
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 space-y-1">
            <div className="flex items-center gap-1.5">
              <FilePenLine className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">
                Files this command changed
              </span>
            </div>

            {editDiff.files.map((f) => (
              <div key={f.filePath} className="flex items-center gap-2 text-[11px] font-mono">
                <span className="truncate flex-1 min-w-0">{f.filePath}</span>
                {f.created && <span className="text-green-400 shrink-0">new</span>}
                {f.deleted && <span className="text-red-400 shrink-0">deleted</span>}
                {f.added > 0 && <span className="text-green-400 shrink-0">+{f.added}</span>}
                {f.removed > 0 && <span className="text-red-400 shrink-0">-{f.removed}</span>}
              </div>
            ))}

            {/*
              `changedFiles` is authoritative where the per-file diff is not:
              "every changed file known, shown or not". Listing the overflow by
              name beats a bare count when the CLI gave us the names.
            */}
            {editDiff.moreFiles > 0 && (
              <div className="text-[11px] text-muted-foreground">
                {editDiff.changedFiles.length > editDiff.files.length
                  ? editDiff.changedFiles
                      .filter((p) => !editDiff.files.some((f) => f.filePath === p))
                      .slice(0, 10)
                      .join(", ")
                  : `+${String(editDiff.moreFiles)} more file${editDiff.moreFiles !== 1 ? "s" : ""}`}
              </div>
            )}

            {editDiff.unavailable && (
              <div className="text-[11px] text-muted-foreground">
                Part of the diff is unavailable.
              </div>
            )}

            {editDiff.shared && (
              <div className="text-[11px] text-amber-500/90">
                Another command ran in this repository at the same time — a change
                made by either may show under either result.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
