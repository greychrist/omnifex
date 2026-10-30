import React from "react";
import { cn } from "@/lib/utils";
import { formatTokens, type ContextPressureLevel } from "@/lib/contextPressure";
import { showsGutterDelta, type ContextTimelinePoint } from "@/lib/contextTimeline";
import type { ViewMode } from "@/components/SessionViewToggle";

/**
 * Green / amber / red by proximity to the budget, so a long session can be
 * scanned for where it got expensive without reading a number.
 *
 * Split into text and background maps because a compaction reset paints its
 * dashes from `currentColor`, which the `text-*` half supplies.
 *
 * Exactly the badge's colour, solid: a lighter, translucent line under a
 * solid badge read as two different greens.
 */
const RAIL_TEXT: Record<ContextPressureLevel, string> = {
  none: "text-emerald-700",
  warn: "text-amber-500",
  critical: "text-red-600",
};

const RAIL_BG: Record<ContextPressureLevel, string> = {
  none: "bg-emerald-700",
  warn: "bg-amber-500",
  critical: "bg-red-600",
};

/** The size badge, in the rail's colour. Solid: it sits on top of the line
 *  and must hide it. No border — the unlayered `* { border-color }` rule
 *  outranks the utilities.
 *
 *  Each pair clears WCAG AA (4.5:1) for its 12px text: emerald-700 5.4,
 *  amber-500 on black 9.8, red-600 4.8. Emerald-600 was 3.7 and failed. */
const BADGE: Record<ContextPressureLevel, string> = {
  none: "bg-emerald-700 text-white",
  warn: "bg-amber-500 text-black",
  critical: "bg-red-600 text-white",
};

/** The annotations under it: solid too, quieter. */
const NOTE = "rounded px-1 py-0.5 bg-muted font-mono text-[10px] leading-none tabular-nums";

export interface ContextTimelineTickProps {
  /** Undefined for rows before the first usage reading. */
  point: ContextTimelinePoint | undefined;
  /** Compact hides sub-2k deltas; Verbose prints every one. */
  viewMode?: ViewMode;
  /**
   * The last row that draws a rail. Caps the line off level with the final
   * message card instead of running 1rem past it.
   *
   * Every row's body column carries `pb-4` so consecutive rails meet through
   * the inter-row gap and read as one continuous line — see `withTimeline` in
   * ClaudeTranscript. The last segment has nothing below it to meet, so that
   * same padding is pure overshoot: the line trailed past the transcript's
   * final card and stopped in mid-air.
   */
  isLast?: boolean;
}

/** Width of the gutter cell — the transcript's left margin, outside the chat
 *  frame (see `data-transcript-frame` in ClaudeTranscript). Shared so the
 *  empty and drawn states agree. */
const GUTTER = "relative w-14 shrink-0 self-stretch select-none min-h-9";

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
 * One row of the transcript's context rail: a slim continuous vertical line,
 * plus a size badge and readout wherever a real usage reading exists.
 *
 * Rendered as a stretched flex cell rather than an absolutely-positioned
 * overlay. The transcript is a plain `.map` of variable-height messages with no
 * virtualization, so letting flexbox own the alignment avoids a resize observer
 * chasing markdown and code blocks as they reflow.
 *
 * See docs/superpowers/specs/2026-07-30-context-timeline-design.md
 */
export const ContextTimelineTick: React.FC<ContextTimelineTickProps> = ({
  point,
  viewMode = 'verbose',
  isLast = false,
}) => {
  // The cell keeps its width before the series starts. Returning null instead
  // un-indented the opening rows while every later row was pushed right by the
  // gutter, which read as the transcript jogging sideways partway down.
  if (!point) return <div data-timeline-gutter className={GUTTER} aria-hidden="true" />;

  const { tokens, delta, prevTokens, isSample, isJump, isReset, fraction, level } = point;

  // The delta a reset row prints is measured across the compaction, which is
  // why it comes from prevTokens rather than `delta` (null there by design).
  const shownDelta = isReset && prevTokens !== null ? tokens - prevTokens : delta;
  const showDelta = isSample && showsGutterDelta(shownDelta, viewMode);

  const beforeAfter =
    prevTokens !== null ? `${formatTokens(prevTokens)} → ${formatTokens(tokens)}` : null;

  const base = isReset
    ? `Context ${formatTokens(tokens)} — reset by /compact${beforeAfter ? ` (${beforeAfter})` : ''}`
    : isSample && beforeAfter
      ? `Context ${formatTokens(tokens)} (${beforeAfter})`
      : `Context ${formatTokens(tokens)}`;
  // The share of the window, which the bar under the number used to show.
  const title = `${base} · ${Math.round(fraction * 100)}% of the window`;

  return (
    <div
      // min-h reserves the readout's own height. Rows in this transcript vary
      // wildly — a compact marker or a collapsed "N Hidden Events" bar is a
      // fraction of the height of a message — and without a floor the cell
      // collapses to the body's height and the next tick starts on top of this
      // one's numbers.
      data-timeline-gutter
      className={GUTTER}
      title={title}
    >
      {/* Spans the row edge to edge. ClaudeTranscript drops the inter-row gap
          while the rail is on, so consecutive rails meet and read as one line. */}
      <div
        data-timeline-rail
        data-timeline-reset={isReset ? "" : undefined}
        className={cn(
          "absolute left-1/2 w-0.5 -translate-x-1/2",
          // `bottom-4` cancels the body column's `pb-4` exactly, so the line
          // ends flush with the card's bottom edge; the rounded cap closes it
          // off rather than leaving a cut stem.
          isLast ? "top-0 bottom-4 rounded-b-full" : "inset-y-0",
          RAIL_TEXT[level],
          !isReset && RAIL_BG[level],
        )}
        style={isReset ? { backgroundImage: RESET_DASHES } : undefined}
      />
      {isSample && (
        // In normal flow, NOT absolute. An absolute readout contributes no
        // height, so a short row let it print over the following tick.
        // `relative` lifts it above the absolute rail, so the badges cover it.
        <div data-timeline-readout className="relative flex flex-col items-center gap-0.5 pt-1">
          {/* The one number worth reading mid-scroll, so it leads, in a badge
              tinted by level. It stays smaller than body text: the gutter is
              4rem, and "compacted" at this size wraps. */}
          <span
            data-timeline-badge
            className={cn(
              "w-fit rounded-sm px-1.5 py-0.5 font-mono text-xs leading-none tabular-nums",
              BADGE[level],
            )}
          >
            {formatTokens(tokens)}
          </span>
          {/* Every turn's delta, not just the jumps — this is now the only
              inline home for context growth, since the banner that used to
              announce it is gone. Compact mode drops the sub-2k noise that
              made "label every step" a bad idea the first time round. */}
          {showDelta && shownDelta !== null && (
            <span
              className={cn(
                NOTE,
                isJump
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground",
              )}
            >
              {shownDelta >= 0 ? `+${formatTokens(shownDelta)}` : `−${formatTokens(-shownDelta)}`}
            </span>
          )}
          {isReset && (
            <span className={cn(NOTE, "text-muted-foreground")}>
              compacted
            </span>
          )}
        </div>
      )}
    </div>
  );
};
