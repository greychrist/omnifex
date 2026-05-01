import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Small uppercase label rendered above each header badge ("account", "branch",
 * "session", etc.). Shared component so a single style change propagates to
 * every caller — folder/branch row, account card, session card, etc.
 */
export function HeaderLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("text-[11px] tracking-wider text-muted-foreground", className)}>
      {children}
    </span>
  );
}
