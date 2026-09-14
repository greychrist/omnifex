import React, { useState } from "react";
import {
  FileText,
  FileEdit,
  GitBranch,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getLanguage } from "@/components/claude/tools/shared";
import { DiffViewer } from "@/components/shared/DiffViewer";

/**
 * Widget for displaying MultiEdit tool usage
 */
export const MultiEditWidget: React.FC<{
  file_path: string;
  edits: { old_string: string; new_string: string }[];
  result?: any;
}> = ({ file_path, edits, result: _result }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const language = getLanguage(file_path);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-2">
        <FileEdit className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Using tool: MultiEdit</span>
      </div>
      <div className="ml-6 space-y-2">
        <div className="flex items-center gap-2">
          <FileText className="h-3 w-3 text-blue-500" />
          <code className="text-xs font-mono text-blue-500">{file_path}</code>
        </div>

        <div className="space-y-1">
          <button
            onClick={() => { setIsExpanded(!isExpanded); }}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-90")} />
            {edits.length} edit{edits.length !== 1 ? 's' : ''}
          </button>

          {isExpanded && (
            <div className="space-y-3 mt-3">
              {edits.map((edit, index) => (
                <div key={index} className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">Edit {index + 1}</div>
                  <DiffViewer
                    oldText={edit.old_string}
                    newText={edit.new_string}
                    language={language}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Widget for displaying MultiEdit tool results with diffs
 */
export const MultiEditResultWidget: React.FC<{
  content: string;
  edits?: { old_string: string; new_string: string }[];
}> = ({ content, edits }) => {
  // If we have the edits array, show a nice diff view
  if (edits && edits.length > 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-3 py-2 bg-green-500/10 rounded-t-md border-b border-green-500/20">
          <GitBranch className="h-4 w-4 text-green-500" />
          <span className="text-sm font-medium text-green-600 dark:text-green-400">
            {edits.length} Changes Applied
          </span>
        </div>

        <div className="space-y-4">
          {edits.map((edit, index) => {
            // Split the strings into lines for diff display
            const oldLines = edit.old_string.split('\n');
            const newLines = edit.new_string.split('\n');

            return (
              <div key={index} className="border border-border/50 rounded-md overflow-hidden">
                <div className="px-3 py-1 bg-muted/50 border-b border-border/50">
                  <span className="text-xs font-medium text-muted-foreground">Change {index + 1}</span>
                </div>

                <div className="font-mono text-xs">
                  {/* Show removed lines */}
                  {oldLines.map((line, lineIndex) => (
                    <div
                      key={`old-${lineIndex}`}
                      className="flex bg-red-500/10 border-l-4 border-red-500"
                    >
                      <span className="w-12 px-2 py-1 text-red-600 dark:text-red-400 select-none text-right bg-red-500/10">
                        -{lineIndex + 1}
                      </span>
                      <pre className="flex-1 px-3 py-1 text-red-700 dark:text-red-300 overflow-x-auto">
                        <code>{line || ' '}</code>
                      </pre>
                    </div>
                  ))}

                  {/* Show added lines */}
                  {newLines.map((line, lineIndex) => (
                    <div
                      key={`new-${lineIndex}`}
                      className="flex bg-green-500/10 border-l-4 border-green-500"
                    >
                      <span className="w-12 px-2 py-1 text-green-600 dark:text-green-400 select-none text-right bg-green-500/10">
                        +{lineIndex + 1}
                      </span>
                      <pre className="flex-1 px-3 py-1 text-green-700 dark:text-green-300 overflow-x-auto">
                        <code>{line || ' '}</code>
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Fallback to simple content display
  return (
    <div className="p-3 bg-muted/50 rounded-md border">
      <pre className="text-xs font-mono whitespace-pre-wrap">{content}</pre>
    </div>
  );
};
