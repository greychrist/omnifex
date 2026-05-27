import * as React from "react";
import { cn } from "@/lib/utils";

// shadcn/ui pattern: thin alias around the underlying HTML element's
// attributes so consumers can later add Input-specific props without
// touching every call site.
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Input component for text/number inputs
 * 
 * @example
 * <Input type="text" placeholder="Enter value..." />
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm transition-colors",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "focus-visible:outline-none focus-visible:ring-1",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        style={{
          borderColor: "var(--color-input)",
          backgroundColor: "var(--color-background)",
          color: "var(--color-foreground)"
        }}
        ref={ref}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

export { Input }; 