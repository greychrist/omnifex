import React from "react";
import * as Diff from "diff";
import { cn } from "@/lib/utils";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { getClaudeSyntaxTheme } from "@/lib/claudeSyntaxTheme";
import { useTheme } from "@/hooks";

/**
 * Renders a unified line-level diff between two strings.
 *
 * Lifted out of `EditWidget` so the Claude `Edit` tool and the Codex
 * `apply_patch` item can share identical visuals. Behavior matches the
 * original EditWidget rendering: contiguous unchanged spans longer than
 * 8 lines collapse to a "... N unchanged lines ..." separator, trailing
 * newlines are trimmed from each part, and each part is syntax-highlighted
 * via Prism using `language`.
 */
export interface DiffViewerProps {
  oldText: string;
  newText: string;
  /** Language id understood by react-syntax-highlighter's Prism (e.g. 'tsx'). */
  language: string;
  /** Optional className applied to the outer scroll container. */
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
            ? "bg-green-950/20"
            : part.removed
            ? "bg-red-950/20"
            : "";

          if (!part.added && !part.removed && part.count && part.count > 8) {
            return (
              <div
                key={index}
                className="px-4 py-1 bg-muted border-y border-border text-center text-muted-foreground text-xs"
              >
                ... {part.count} unchanged lines ...
              </div>
            );
          }

          const value = part.value.endsWith("\n")
            ? part.value.slice(0, -1)
            : part.value;

          return (
            <div key={index} className={cn(partClass, "flex")}>
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
