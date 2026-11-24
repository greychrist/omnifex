import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipSimple } from "@/components/ui/tooltip-modern";
import { ICON_BUTTON_CHROME } from "@/lib/surfaceStyles";
import { cn } from "@/lib/utils";

export function NewSessionButton({
  onClick,
  disabled = false,
  reason,
}: {
  onClick: () => void;
  disabled?: boolean;
  reason?: string;
}): React.JSX.Element {
  return (
    // Tooltip hangs off a wrapper: a disabled button fires no pointer events, and the reason is what's worth reading then.
    <TooltipSimple content={reason ?? "Close this session and open a new one"} side="bottom">
      <span className="flex" tabIndex={disabled ? 0 : undefined}>
        <Button
          size="sm"
          variant="outline"
          onClick={onClick}
          disabled={disabled}
          aria-label="New session"
          className={cn("h-7 w-7", ICON_BUTTON_CHROME)}
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </span>
    </TooltipSimple>
  );
}
