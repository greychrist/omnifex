import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipSimple } from "@/components/ui/tooltip-modern";

/**
 * Close this session and open a new one — the session widget's button, moved
 * beside the back button while the header widgets are hidden. Same glyph and
 * gating; the confirm prompt stays with the caller.
 */
export function NewSessionButton({
  onClick,
  disabled = false,
  reason,
}: {
  onClick: () => void;
  disabled?: boolean;
  /** Why it is disabled, shown in the tooltip in place of what it does. */
  reason?: string;
}): React.JSX.Element {
  return (
    // The back button's styled tooltip. It hangs off a wrapper because a
    // disabled button fires no pointer events, and the reason it is disabled
    // is the one thing worth reading then. The wrapper takes focus only while
    // the button cannot, so keyboard users get one tab stop either way.
    <TooltipSimple content={reason ?? "Close this session and open a new one"} side="bottom">
      <span className="flex" tabIndex={disabled ? 0 : undefined}>
        <Button
          size="sm"
          variant="outline"
          onClick={onClick}
          disabled={disabled}
          aria-label="New session"
          // The back button's chrome and size; the two sit side by side.
          className="h-7 w-7 p-0 rounded-sm border-0 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </span>
    </TooltipSimple>
  );
}
