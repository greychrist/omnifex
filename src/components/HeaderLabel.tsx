import * as React from "react";
import { cn } from "@/lib/utils";

export function HeaderLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("text-[11px] tracking-wider text-muted-foreground", className)}>
      {children}
    </span>
  );
}
