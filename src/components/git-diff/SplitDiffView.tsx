import React, { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { UnfoldVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { SplitHandle } from "@/components/ui/SplitHandle";
import { useTheme } from "@/hooks";
import { getClaudeSyntaxTheme } from "@/lib/claudeSyntaxTheme";
import { toSplitRows, type SplitCell, type SplitRow } from "@/lib/splitDiff";
import type { DiffFile } from "@/lib/unifiedDiff";

/**
 * Side-by-side diff for one file: old on the left, new on the right, each with
 * its own line-number gutter.
 *
 * Unlike `UnifiedDiffView` — which renders a patch inline in the transcript and
 * therefore refuses to syntax-highlight — this mounts in a full-screen overlay
 * and highlights. The reason that rule exists is the unvirtualised transcript:
 * Prism per line across a 20,000-line diff is a render storm. Here the rows ARE
 * virtualised above `VIRTUALIZE_ABOVE`, so only what is on screen is tokenised.
 *
 * Below that threshold rows render directly. Virtualising a 40-row diff costs
 * more than it saves, and a plain list measures and scrolls correctly with no
 * height estimation at all.
 */

/** Row count past which rows are windowed rather than all mounted. */
const VIRTUALIZE_ABOVE = 200;

/** Starting row-height estimate, refined per row by `measureElement`. */
const ESTIMATED_ROW_HEIGHT = 20;

/** Width of one line-number gutter (`NumberCell`'s `w-[52px]`). Two sit outside the split. */
const GUTTER_PX = 52;

/**
 * The old side's share of the code width. A fraction rather than pixels, so
 * the split survives the file list being resized and the window changing.
 */
const RATIO_STORAGE_KEY = "omnifex.gitDiff.splitRatio";
const DEFAULT_RATIO = 0.5;
/** Neither side may be dragged shut — a vanished side has no handle left to grab. */
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

function clampRatio(n: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, Math.round(n * 1000) / 1000));
}

function readRatio(): number {
  try {
    const raw = window.localStorage.getItem(RATIO_STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? clampRatio(n) : DEFAULT_RATIO;
  } catch {
    return DEFAULT_RATIO;
  }
}

/**
 * Each side's flex-grow reads `--diff-left` off the view's root, so a drag
 * re-styles every row through one custom property instead of a new prop per
 * row. Constant objects: the rows never see a changed style reference.
 */
const LEFT_SIDE_STYLE: React.CSSProperties = { flex: "var(--diff-left) 1 0%" };
const RIGHT_SIDE_STYLE: React.CSSProperties = { flex: "calc(1 - var(--diff-left)) 1 0%" };

export interface SplitDiffViewProps {
  file: DiffFile;
  /** Language id for Prism, e.g. `tsx`. */
  language: string;
  /** Ask for more unchanged context around the hunks. */
  onExpandContext?: () => void;
  /** False once the whole file is already on screen. */
  canExpandContext?: boolean;
  className?: string;
}

const SIDE_TINT: Record<SplitCell["kind"], string> = {
  del: "bg-red-500/10",
  add: "bg-green-500/10",
  ctx: "",
  none: "bg-muted/25",
};

const NUMBER_TINT: Record<SplitCell["kind"], string> = {
  del: "bg-red-500/15 text-red-200/70",
  add: "bg-green-500/15 text-green-200/70",
  ctx: "text-muted-foreground/50",
  none: "bg-muted/25",
};

interface CodeCellProps {
  cell: SplitCell;
  language: string;
  syntaxTheme: Record<string, React.CSSProperties>;
}

/**
 * One side of one row. Memoised because a scroll that changes the window by a
 * few rows must not re-tokenise the rows that stayed.
 */
const CodeCell = React.memo<CodeCellProps>(({ cell, language, syntaxTheme }) => {
  if (cell.kind === "none") {
    return <div role="cell" data-diff-side="none" className={cn("px-2", SIDE_TINT.none)} />;
  }
  return (
    <div
      role="cell"
      data-diff-side={cell.kind}
      className={cn("min-w-0 px-2", SIDE_TINT[cell.kind])}
    >
      <SyntaxHighlighter
        language={language}
        style={syntaxTheme}
        PreTag="div"
        wrapLongLines
        customStyle={{
          margin: 0,
          padding: 0,
          background: "transparent",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
        codeTagProps={{ style: { fontSize: "11px", lineHeight: "1.55" } }}
      >
        {cell.text}
      </SyntaxHighlighter>
    </div>
  );
});
CodeCell.displayName = "CodeCell";

const NumberCell: React.FC<{ cell: SplitCell }> = ({ cell }) => (
  <div
    role="cell"
    className={cn(
      "w-[52px] flex-none select-none px-2 text-right font-mono text-[10px] leading-[1.55]",
      NUMBER_TINT[cell.kind],
    )}
  >
    {cell.number ?? ""}
  </div>
);

interface RowRendererProps {
  row: SplitRow;
  language: string;
  syntaxTheme: Record<string, React.CSSProperties>;
  canExpandContext: boolean;
  onExpandContext?: () => void;
}

const RowRenderer: React.FC<RowRendererProps> = ({
  row,
  language,
  syntaxTheme,
  canExpandContext,
  onExpandContext,
}) => {
  if (row.kind === "gap") {
    const expandable = canExpandContext && row.hiddenBefore > 0;
    return (
      <div role="row" className="flex items-center bg-sky-500/8 text-[10px]">
        <div role="cell" className="w-[104px] flex-none px-1 py-1">
          {expandable && (
            <button
              type="button"
              aria-label={`Expand ${row.hiddenBefore} hidden lines`}
              onClick={onExpandContext}
              className="flex w-full items-center justify-center gap-1 rounded-sm py-0.5 text-sky-300/80 hover:bg-sky-500/20 hover:text-sky-200"
            >
              <UnfoldVertical className="h-3 w-3" />
            </button>
          )}
        </div>
        <div role="cell" className="min-w-0 flex-1 truncate px-2 py-1 font-mono text-sky-200/60">
          {row.hiddenBefore > 0 && (
            <span className="mr-2 text-sky-300/70">{row.hiddenBefore} lines hidden</span>
          )}
          {row.header}
        </div>
      </div>
    );
  }

  return (
    <div role="row" className="flex items-stretch font-mono text-[11px] leading-[1.55]">
      <NumberCell cell={row.left} />
      <div className="min-w-0" style={LEFT_SIDE_STYLE}>
        <CodeCell cell={row.left} language={language} syntaxTheme={syntaxTheme} />
      </div>
      <NumberCell cell={row.right} />
      <div className="min-w-0" style={RIGHT_SIDE_STYLE}>
        <CodeCell cell={row.right} language={language} syntaxTheme={syntaxTheme} />
      </div>
    </div>
  );
};

export const SplitDiffView: React.FC<SplitDiffViewProps> = ({
  file,
  language,
  onExpandContext,
  canExpandContext = false,
  className,
}) => {
  const { theme } = useTheme();
  const syntaxTheme = getClaudeSyntaxTheme(theme);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [ratio, setRatio] = useState(readRatio);
  /** The live ratio, so the mouse-up persists the last move, not the first render's. */
  const ratioRef = useRef(ratio);

  // Window-level listeners, as in `useSplitWidth`: the handle is a few pixels
  // wide and the cursor outruns it mid-drag.
  const startResize = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent): void => {
      const rect = el.getBoundingClientRect();
      const codeWidth = rect.width - 2 * GUTTER_PX;
      if (codeWidth <= 0) return;
      const next = clampRatio((ev.clientX - rect.left - GUTTER_PX) / codeWidth);
      ratioRef.current = next;
      setRatio(next);
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      try {
        window.localStorage.setItem(RATIO_STORAGE_KEY, String(ratioRef.current));
      } catch {
        // Quota. The split reverts on reload, which is not worth an error.
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const resetRatio = useCallback((): void => {
    ratioRef.current = DEFAULT_RATIO;
    setRatio(DEFAULT_RATIO);
    try { window.localStorage.removeItem(RATIO_STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  const rows = useMemo(() => toSplitRows(file), [file]);
  const shouldVirtualize = rows.length > VIRTUALIZE_ABOVE;

  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 24,
  });

  if (file.binary) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <p className="text-[12px] text-muted-foreground">
          Binary file — no text diff to show.
        </p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <p className="text-[12px] text-muted-foreground">No changes to display.</p>
      </div>
    );
  }

  const renderRow = (row: SplitRow, key: React.Key): React.ReactNode => (
    <RowRenderer
      key={key}
      row={row}
      language={language}
      syntaxTheme={syntaxTheme}
      canExpandContext={canExpandContext}
      onExpandContext={onExpandContext}
    />
  );

  return (
    <div
      data-testid="split-diff"
      className={cn("relative h-full", className)}
      style={{ "--diff-left": ratio } as React.CSSProperties}
    >
      <div
        ref={scrollRef}
        role="table"
        data-virtualized={shouldVirtualize}
        data-total-rows={rows.length}
        className="h-full overflow-auto"
      >
        {shouldVirtualize ? (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {renderRow(rows[item.index], item.key)}
              </div>
            ))}
          </div>
        ) : (
          rows.map((row, i) => renderRow(row, i))
        )}
      </div>
      {/* Overlays the rows rather than living in them: one handle for the
          whole view, and it stays put while the rows scroll beneath it. */}
      <div
        className="absolute inset-y-0 z-10 flex"
        style={{ left: `calc(${GUTTER_PX}px + var(--diff-left) * (100% - ${2 * GUTTER_PX}px))` }}
      >
        <SplitHandle
          label="Resize the old and new sides"
          onMouseDown={startResize}
          onDoubleClick={resetRatio}
        />
      </div>
    </div>
  );
};
