import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import { ICON_BUTTON_CHROME } from "@/lib/surfaceStyles";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: { button: "h-7 w-7", icon: "h-4 w-4" },
  md: { button: "h-8 w-8", icon: "h-4 w-4" },
  lg: { button: "h-12 w-12", icon: "h-6 w-6" },
} as const;

/**
 * The app's one back button: the session header's chrome at any size. The
 * label names where it goes and doubles as the tooltip and accessible name.
 * Renders anywhere: it brings its own TooltipProvider.
 */
export function BackButton({
  label,
  onClick,
  size = "sm",
  disabled = false,
  className,
}: {
  label: string;
  onClick: () => void;
  size?: keyof typeof SIZES;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  // Its own provider: several screens it sits on mount none, and Radix
  // throws without one. A nested provider is harmless where one exists.
  return (
    <TooltipProvider>
      <TooltipSimple content={label} side="bottom">
        <Button
          size="sm"
          variant="outline"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(SIZES[size].button, ICON_BUTTON_CHROME, className)}
        >
          <ArrowLeft className={SIZES[size].icon} />
        </Button>
      </TooltipSimple>
    </TooltipProvider>
  );
}
