import React from "react";
import { cn } from "@/lib/utils";
import { formatTokens, type ContextPressureLevel } from "@/lib/contextPressure";
import type { ContextTimelinePoint } from "@/lib/contextTimeline";

/**
 * Green / amber / red by proximity to the budget, so a long session can be
 * scanned for where it got expensive without reading a number.
 *
 * Split into text and background maps because a compaction reset paints its
 * dashes from `currentColor`, which the `text-*` half supplies.
 */
const RAIL_TEXT: Record<ContextPressureLevel, string> = {
  none: "text-emerald-500",
  warn: "text-amber-500",
  critical: "text-red-500",
};

const RAIL_BG: Record<ContextPressureLevel, string> = {
  none: "bg-emerald-500/60",
  warn: "bg-amber-500/80",
  critical: "bg-red-500",
};

const BAR_BG: Record<ContextPressureLevel, string> = {
  none: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

export interface ContextTimelineTickProps {
  /** Undefined for rows before the first usage reading. */
  point: ContextTimelinePoint | undefined;
}

/** Width of the gutter cell. Shared so the empty and drawn states agree. */
const GUTTER = "relative w-16 shrink-0 self-stretch select-none min-h-9";

/**
 * Dashes for a compaction reset, drawn as a gradient rather than a dashed
 * border. A border cannot carry the level colour here: styles.css declares an
 * unlayered `* { border-color: var(--color-border) }` that outranks every
 * Tailwind border-color utility, and a 4px dashed border would also need a
 * zero-width box to line up with the solid rail.
 */
const RESET_DASHES =
  "repeating-linear-gradient(to bottom, currentColor 0 4px, transparent 4px 8px)";

/**
 * One row of the transcript's context rail: a continuous vertical line, plus a
 * proportional bar and readout wherever a real usage reading exists.
 *
 * Rendered as a stretched flex cell rather than an absolutely-positioned
 * overlay. The transcript is a plain `.map` of variable-height messages with no
 * virtualization, so letting flexbox own the alignment avoids a resize observer
 * chasing markdown and code blocks as they reflow.
 *
 * See docs/superpowers/specs/2026-07-30-context-timeline-design.md
 */
export const ContextTimelineTick: React.FC<ContextTimelineTickProps> = ({ point }) => {
  // The cell keeps its width before the series starts. Returning null instead
  // un-indented the opening rows while every later row was pushed right by the
  // gutter, which read as the transcript jogging sideways partway down.
  if (!point) return <div className={GUTTER} aria-hidden="true" />;

  const { tokens, delta, isSample, isJump, isReset, fraction, level } = point;

  const title = isReset
    ? `Context ${formatTokens(tokens)} — reset by /compact`
    : isSample && delta !== null
      ? `Context ${formatTokens(tokens)} (${delta >= 0 ? '+' : ''}${formatTokens(delta)} this step)`
      : `Context ${formatTokens(tokens)}`;

  return (
    <div
      // min-h reserves the readout's own height. Rows in this transcript vary
      // wildly — a compact marker or a collapsed "N Hidden Events" bar is a
      // fraction of the height of a message — and without a floor the cell
      // collapses to the body's height and the next tick starts on top of this
      // one's numbers.
      className={GUTTER}
      title={title}
    >
      {/* Spans the row edge to edge. ClaudeTranscript drops the inter-row gap
          while the rail is on, so consecutive rails meet and read as one line. */}
      <div
        data-timeline-rail
        data-timeline-reset={isReset ? "" : undefined}
        className={cn("absolute inset-y-0 left-0 w-1", RAIL_TEXT[level], !isReset && RAIL_BG[level])}
        style={isReset ? { backgroundImage: RESET_DASHES } : undefined}
      />
      {isSample && (
        // In normal flow, NOT absolute. An absolute readout contributes no
        // height, so a short row let it print over the following tick.
        <div data-timeline-readout className="ml-2 flex flex-col gap-0.5 pt-1">
          {/* The one number worth reading mid-scroll, so it leads and is a step
              up in size from the annotations. It stays smaller than body text:
              the gutter is 4rem, and "compacted" at this size wraps. */}
          <span
            className={cn(
              "font-mono text-xs leading-none",
              isJump ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
            )}
          >
            {formatTokens(tokens)}
          </span>
          <div className="h-1 w-full rounded-sm bg-muted/60 overflow-hidden">
            <div
              data-timeline-bar
              // Level, not jump. The two are orthogonal — level is where the
              // session sits, the ▲ label below is what the last step did —
              // and colouring the bar by jump made a 20k step near the ceiling
              // look calmer than a 60k step at the start.
              className={cn("h-full rounded-sm", BAR_BG[level])}
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
          {/* Only jumps get a delta. Labelling every step turns the rail into noise. */}
          {isJump && delta !== null && (
            <span className="font-mono text-[10px] leading-none text-amber-600 dark:text-amber-400">
              ▲ +{formatTokens(delta)}
            </span>
          )}
          {isReset && (
            <span className="font-mono text-[10px] leading-none text-muted-foreground">
              compacted
            </span>
          )}
        </div>
      )}
    </div>
  );
};
