import React from "react";
import { BarChartHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipSimple } from "@/components/ui/tooltip-modern";
import { cn } from "@/lib/utils";

export interface ContextTimelineToggleProps {
  active: boolean;
  onToggle: () => void;
}

/** Active state is a filled background: a tinted glyph alone is near-invisible at 14px. */
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
