import * as React from "react";
import { cn } from "@/lib/utils";

/** shadcn's Skeleton (ui.shadcn.com/docs/components/base/skeleton). */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
