import React from "react";
import { cn } from "@/lib/utils";
import { formatTokens, type ContextPressureLevel } from "@/lib/contextPressure";
import { showsGutterDelta, type ContextTimelinePoint } from "@/lib/contextTimeline";
import type { ViewMode } from "@/components/SessionViewToggle";

const RAIL_BG: Record<ContextPressureLevel, string | null> = {
  none: null,
  warn: "bg-amber-500",
  critical: "bg-red-600",
};

// No border: the unlayered `* { border-color }` rule outranks the utilities. Each pair clears WCAG AA for 12px text.
const BADGE: Record<ContextPressureLevel, string> = {
  none: "bg-emerald-700 text-white",
  warn: "bg-amber-500 text-black",
  critical: "bg-red-600 text-white",
};

// Edge is an inset shadow: border-color utilities lose to the unlayered `* { border-color }` rule, and styles.css nulls `.ring-1`.
const NOTE =
  "rounded px-1 py-0.5 font-mono text-[10px] leading-none tabular-nums " +
  "bg-[color-mix(in_oklch,var(--color-foreground)_14%,var(--color-background))] " +
  "shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-foreground)_28%,transparent)]";

const NOTE_TEXT = "text-foreground/85";

export interface ContextTimelineTickProps {
  point: ContextTimelinePoint | undefined;
  viewMode?: ViewMode;
  isLast?: boolean;
}

const GUTTER = "relative w-14 shrink-0 self-stretch select-none min-h-9";

export const ContextTimelineTick: React.FC<ContextTimelineTickProps> = ({
  point,
  viewMode = 'expanded',
  isLast = false,
}) => {
  // Keep the cell's width before the series starts; returning null jogs the opening rows sideways.
  if (!point) return <div data-timeline-gutter className={GUTTER} aria-hidden="true" />;

  const { tokens, delta, prevTokens, isSample, isJump, isReset, fraction, level } = point;

  // Reset rows measure across the compaction; `delta` is null there by design.
  const shownDelta = isReset && prevTokens !== null ? tokens - prevTokens : delta;
  const showDelta = isSample && showsGutterDelta(shownDelta, viewMode);

  const beforeAfter =
    prevTokens !== null ? `${formatTokens(prevTokens)} → ${formatTokens(tokens)}` : null;

  const base = isReset
    ? `Context ${formatTokens(tokens)} — reset by /compact${beforeAfter ? ` (${beforeAfter})` : ''}`
    : isSample && beforeAfter
      ? `Context ${formatTokens(tokens)} (${beforeAfter})`
      : `Context ${formatTokens(tokens)}`;
  const title = `${base} · ${Math.round(fraction * 100)}% of the window`;

  return (
    <div
      // min-h floor: short rows otherwise collapse and the next tick prints over this one's numbers.
      data-timeline-gutter
      className={GUTTER}
      title={title}
    >
      <div
        data-timeline-rail
        className={cn(
          "absolute left-[7px] w-px",
          // `bottom-4` cancels the body column's `pb-4` so the last line ends flush with its card.
          isLast ? "top-0 bottom-4 rounded-b-full" : "inset-y-0",
          RAIL_BG[level],
        )}
      />
      {isSample && (
        // In normal flow, not absolute: an absolute readout has no height and prints over the next tick.
        <div data-timeline-readout className="relative flex flex-col items-start gap-0.5 pl-2 pt-1">
          {showDelta && shownDelta !== null && (
            <span
              className={cn(
                NOTE,
                isJump
                  ? "text-amber-600 dark:text-amber-400"
                  : NOTE_TEXT,
              )}
            >
              {shownDelta >= 0 ? `+${formatTokens(shownDelta)}` : `−${formatTokens(-shownDelta)}`}
            </span>
          )}
          {isReset && (
            <span className={cn(NOTE, NOTE_TEXT)}>
              compacted
            </span>
          )}
          <span
            data-timeline-badge
            className={cn(
              "w-fit rounded-sm px-1.5 py-0.5 font-mono text-xs leading-none tabular-nums",
              BADGE[level],
            )}
          >
            {formatTokens(tokens)}
          </span>
        </div>
      )}
    </div>
  );
};
