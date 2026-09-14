import React from "react";
import { cn } from "@/lib/utils";
import type { DiffFile, DiffLine, ParsedDiff } from "@/lib/unifiedDiff";

/**
 * A unified diff, rendered as a diff.
 *
 * Three rules hold this together, and each replaces something the flat
 * success-green block got wrong:
 *
 *  - **The tint is on the row, not the text.** Code keeps `foreground`, so a
 *    diff stays readable as code; colour means "this line changed" rather
 *    than "this command exited 0".
 *  - **The sign column is the only saturated colour**, and it carries a glyph.
 *    Position and shape say add/remove before colour does, so the scan
 *    survives a screenshot, a colourblind reader, or a monochrome print.
 *  - **Line numbers come from the hunk header**, which is the one thing a
 *    wall of stdout cannot give you.
 *
 * Tints are `/12` and `/10` of the mid-tone 500 hues, not the 950s: a
 * near-black at 20% is invisible on a dark background and wrong on a light
 * one, and these two themes share one component. Rails are inset box-shadows
 * because `* { border-color }` in styles.css overrides every Tailwind
 * border-colour utility app-wide.
 *
 * There is no syntax highlighting here on purpose. The transcript is
 * unvirtualised, and a Prism pass per line is the render storm CLAUDE.md
 * warns about; the diff's own colours are the information anyway.
 */

// Dim enough to stay behind the code, legible enough to be worth reading —
// at 10px, /50 was decoration rather than a line number.
const GUTTER = "w-10 shrink-0 select-none text-right tabular-nums text-[10px] text-muted-foreground/75";

function Line({ line }: { line: DiffLine }) {
  const added = line.kind === "add";
  const removed = line.kind === "del";
  return (
    <div
      data-diff-line={line.kind}
      className={cn(
        "flex items-start",
        // Equal perceived weight, not equal alpha: this theme's green-500 is
        // far more saturated than red-500, so matching the numbers made every
        // addition a slab and every removal a whisper.
        added && "bg-green-500/8 shadow-[inset_2px_0_0_0_color-mix(in_oklch,var(--color-green-500)_70%,transparent)]",
        removed && "bg-red-500/10 shadow-[inset_2px_0_0_0_color-mix(in_oklch,var(--color-red-500)_70%,transparent)]",
      )}
    >
      <span className={cn(GUTTER, "pl-2")}>{line.oldNumber ?? ""}</span>
      <span className={cn(GUTTER, "pr-1")}>{line.newNumber ?? ""}</span>
      <span
        className={cn(
          "w-4 shrink-0 select-none text-center",
          added && "text-green-400",
          removed && "text-red-400",
        )}
      >
        {added ? "+" : removed ? "-" : " "}
      </span>
      <span className="whitespace-pre flex-1 pr-3 text-foreground/90">
        {line.text === "" ? " " : line.text}
      </span>
    </div>
  );
}

function FileBlock({ file }: { file: DiffFile }) {
  // What happened to the file, in the words the rest of the widget uses.
  const state = file.created
    ? "new"
    : file.deleted
      ? "deleted"
      : file.renamed
        ? "renamed"
        : null;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2 px-3 py-1.5 bg-muted/40">
        <span className="truncate text-[11px] text-foreground">{file.path}</span>
        {file.oldPath && (
          <span className="truncate text-[11px] text-muted-foreground">
            was {file.oldPath}
          </span>
        )}
        {state && <span className="shrink-0 text-[10px] text-muted-foreground">{state}</span>}
        <span className="ml-auto shrink-0 tabular-nums text-[10px]">
          {file.added > 0 && <span className="text-green-400">+{file.added}</span>}
          {file.added > 0 && file.removed > 0 && <span className="text-muted-foreground"> </span>}
          {file.removed > 0 && <span className="text-red-400">-{file.removed}</span>}
        </span>
      </div>

      {file.binary && (
        <div className="px-3 py-1.5 text-[11px] text-muted-foreground">
          Binary file — no line changes to show.
        </div>
      )}

      {file.hunks.map((hunk, i) => (
        <div key={i}>
          <div className="px-3 py-1 bg-muted/20 text-[10px] text-muted-foreground/70 whitespace-pre truncate">
            {hunk.header}
          </div>
          {hunk.lines.map((line, j) => (
            <Line key={j} line={line} />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface UnifiedDiffViewProps {
  diff: ParsedDiff;
  className?: string;
}

export const UnifiedDiffView: React.FC<UnifiedDiffViewProps> = ({ diff, className }) => {
  return (
    <div className={cn("rounded-md bg-background/60 overflow-hidden font-mono text-[11px] leading-[1.55]", className)}>
      {diff.preamble.length > 0 && (
        <div className="px-3 py-1.5 whitespace-pre-wrap text-[11px] text-muted-foreground">
          {diff.preamble.join("\n")}
        </div>
      )}
      <div className="max-h-[440px] overflow-auto">
        {/* `w-max min-w-full` so a row's tint spans the widest line rather
            than stopping at the viewport edge when the diff is scrolled. */}
        <div className="w-max min-w-full">
          {diff.files.map((file, i) => (
            <FileBlock key={`${file.path}-${String(i)}`} file={file} />
          ))}
          {diff.truncated > 0 && (
            <div className="px-3 py-1.5 bg-muted/40 text-[11px] text-muted-foreground">
              {diff.truncated} more changed lines — run the command in a terminal to see the rest.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
