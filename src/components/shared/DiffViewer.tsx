import React from "react";
import * as Diff from "diff";
import { cn } from "@/lib/utils";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { getClaudeSyntaxTheme } from "@/lib/claudeSyntaxTheme";
import { useTheme } from "@/hooks";

/**
 * Colors match `UnifiedDiffView`. Unlike it, this highlights: an Edit's diff is
 * a handful of lines, not an arbitrarily large `git diff`.
 */
export interface DiffViewerProps {
  oldText: string;
  newText: string;
  language: string;
  className?: string;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  oldText,
  newText,
  language,
  className,
}) => {
  const { theme } = useTheme();
  const syntaxTheme = getClaudeSyntaxTheme(theme);

  const diffResult = Diff.diffLines(oldText || "", newText || "", {
    newlineIsToken: true,
    ignoreWhitespace: false,
  });

  return (
    <div
      className={cn(
        "rounded-lg border bg-background overflow-hidden text-xs font-mono",
        className,
      )}
    >
      <div className="max-h-[440px] overflow-y-auto overflow-x-auto">
        {diffResult.map((part, index) => {
          const partClass = part.added
            ? "bg-green-500/8 shadow-[inset_2px_0_0_0_color-mix(in_oklch,var(--color-green-500)_70%,transparent)]"
            : part.removed
            ? "bg-red-500/10 shadow-[inset_2px_0_0_0_color-mix(in_oklch,var(--color-red-500)_70%,transparent)]"
            : "";

          if (!part.added && !part.removed && part.count && part.count > 8) {
            return (
              <div
                key={index}
                className="px-3 py-1 bg-muted/20 text-[10px] text-muted-foreground/70"
              >
                … {part.count} unchanged lines
              </div>
            );
          }

          const value = part.value.endsWith("\n")
            ? part.value.slice(0, -1)
            : part.value;

          return (
            <div
              key={index}
              data-diff-line={part.added ? "add" : part.removed ? "del" : "ctx"}
              className={cn(partClass, "flex")}
            >
              <div className="w-8 select-none text-center flex-shrink-0">
                {part.added ? (
                  <span className="text-green-400">+</span>
                ) : part.removed ? (
                  <span className="text-red-400">-</span>
                ) : null}
              </div>
              <div className="flex-1">
                <SyntaxHighlighter
                  language={language}
                  style={syntaxTheme}
                  PreTag="div"
                  wrapLongLines={false}
                  customStyle={{
                    margin: 0,
                    padding: 0,
                    background: "transparent",
                  }}
                  codeTagProps={{
                    style: {
                      fontSize: "0.75rem",
                      lineHeight: "1.6",
                    },
                  }}
                >
                  {value}
                </SyntaxHighlighter>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
