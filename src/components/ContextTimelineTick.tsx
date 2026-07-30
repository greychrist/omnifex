import React from "react";
import { cn } from "@/lib/utils";
import { formatTokens } from "@/lib/contextPressure";
import type { ContextTimelinePoint } from "@/lib/contextTimeline";

export interface ContextTimelineTickProps {
  /** Undefined for rows before the first usage reading. */
  point: ContextTimelinePoint | undefined;
}

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
  if (!point) return null;

  const { tokens, delta, isSample, isJump, isReset, fraction } = point;

  const title = isReset
    ? `Context ${formatTokens(tokens)} — reset by /compact`
    : isSample && delta !== null
      ? `Context ${formatTokens(tokens)} (${delta >= 0 ? '+' : ''}${formatTokens(delta)} this step)`
      : `Context ${formatTokens(tokens)}`;

  return (
    <div
      className="relative w-16 shrink-0 self-stretch select-none"
      title={title}
    >
      {/* The rail: a hairline spanning the row so the series reads continuous. */}
      <div
        data-timeline-rail
        className={cn(
          "absolute inset-y-0 left-0 w-px",
          isReset ? "bg-transparent border-l border-dashed border-border" : "bg-border",
        )}
      />
      {isSample && (
        <div className="absolute left-1 right-0 top-0 flex flex-col gap-0.5 pt-1">
          <div className="h-1 w-full rounded-sm bg-muted/60 overflow-hidden">
            <div
              data-timeline-bar
              className={cn("h-full rounded-sm", isJump ? "bg-amber-500" : "bg-primary/50")}
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
          <span
            className={cn(
              "font-mono text-[10px] leading-none",
              isJump ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
            )}
          >
            {formatTokens(tokens)}
          </span>
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
