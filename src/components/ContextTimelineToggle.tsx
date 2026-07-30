import React from "react";
import { BarChartHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipSimple } from "@/components/ui/tooltip-modern";
import { cn } from "@/lib/utils";

export interface ContextTimelineToggleProps {
  active: boolean;
  onToggle: () => void;
}

/**
 * Shows/hides the transcript's context rail.
 *
 * Lives at the bottom-LEFT of the transcript rather than in the scroll-button
 * stack on the right, because the rail it controls renders in the left gutter —
 * a control on the far side of the message column from its own effect reads as
 * unrelated chrome.
 *
 * The active state is carried by a filled background, not by icon colour alone:
 * a tinted glyph against a translucent button is close to invisible at 14px,
 * which is exactly the "is it on?" problem this control has to answer.
 */
export const ContextTimelineToggle: React.FC<ContextTimelineToggleProps> = ({
  active,
  onToggle,
}) => (
  <TooltipSimple
    content={active ? "Hide context timeline" : "Show context timeline"}
    side="right"
  >
    <Button
      variant="ghost"
      size="icon"
      aria-label={active ? "Hide context timeline" : "Show context timeline"}
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        "h-8 w-8 transition-colors backdrop-blur-sm border",
        active
          ? "bg-primary/20 text-primary border-primary/50 hover:bg-primary/30"
          : "bg-background/80 border-border/50 hover:bg-accent/50",
      )}
    >
      <BarChartHorizontal className="h-3.5 w-3.5" />
    </Button>
  </TooltipSimple>
);
