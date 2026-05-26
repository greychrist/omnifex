import * as React from "react";
import { cn } from "@/lib/utils";

export type TabsVariant = "pill" | "line";

const TabsContext = React.createContext<{
  value: string;
  onValueChange: (value: string) => void;
  variant: TabsVariant;
}>({
  value: "",
  onValueChange: () => {},
  variant: "pill",
});

export interface TabsProps {
  /**
   * The controlled value of the tab to activate
   */
  value: string;
  /**
   * Event handler called when the value changes
   */
  onValueChange: (value: string) => void;
  /**
   * Visual variant:
   * - "pill" (default): rounded chips inside a muted bar — the original look.
   * - "line": text labels under a hairline, active tab gets an underline.
   *           Use this on dense pages where pill chrome competes with the
   *           cards beneath (e.g. AppearanceSettings).
   */
  variant?: TabsVariant;
  /**
   * The tabs and their content
   */
  children: React.ReactNode;
  /**
   * Additional CSS classes
   */
  className?: string;
}

/**
 * Root tabs component
 *
 * @example
 * <Tabs value={activeTab} onValueChange={setActiveTab}>
 *   <TabsList>
 *     <TabsTrigger value="general">General</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="general">Content</TabsContent>
 * </Tabs>
 *
 * @example
 * <Tabs value={activeTab} onValueChange={setActiveTab} variant="line">
 *   <TabsList>...</TabsList>
 * </Tabs>
 */
const Tabs: React.FC<TabsProps> = ({
  value,
  onValueChange,
  variant = "pill",
  children,
  className,
}) => {
  return (
    <TabsContext.Provider value={{ value, onValueChange, variant }}>
      <div className={cn("w-full", className)}>{children}</div>
    </TabsContext.Provider>
  );
};

export interface TabsListProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Container for tab triggers. Adapts its chrome based on the active variant.
 */
const TabsList = React.forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, ...props }, ref) => {
    const { variant } = React.useContext(TabsContext);
    if (variant === "line") {
      return (
        <div
          ref={ref}
          className={cn(
            "flex h-9 items-center justify-start gap-1",
            className,
          )}
          {...props}
        />
      );
    }
    return (
      <div
        ref={ref}
        className={cn(
          "flex h-9 items-center justify-start rounded-lg p-1",
          className,
        )}
        style={{
          backgroundColor: "var(--color-muted)",
          color: "var(--color-muted-foreground)",
        }}
        {...props}
      />
    );
  },
);

TabsList.displayName = "TabsList";

export interface TabsTriggerProps {
  value: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}

/**
 * Individual tab trigger button
 */
const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  TabsTriggerProps
>(({ className, value, disabled, ...props }, ref) => {
  const { value: selectedValue, onValueChange, variant } = React.useContext(TabsContext);
  const isSelected = selectedValue === value;

  if (variant === "line") {
    // Inline `borderBottom` instead of Tailwind border utilities. The
    // class-based approach (`border-b-2 border-transparent`) rendered with
    // a visible line on every trigger in this project's Tailwind v4 build
    // — either `border-foreground` wasn't being generated from the
    // `@theme` block or `border-transparent` was being stripped during
    // tailwind-merge. Inline styles bypass both paths and produce the
    // exact bytes we want.
    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        aria-selected={isSelected}
        disabled={disabled}
        onClick={() => { onValueChange(value); }}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap px-3 py-1.5 text-sm font-medium transition-colors",
          "disabled:pointer-events-none disabled:opacity-50",
          isSelected
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground",
          className,
        )}
        style={{
          // Both states render a 2px bottom border so heights match — only
          // the colour differs, and only the active tab's colour is visible.
          borderBottom: isSelected
            ? "2px solid var(--color-foreground)"
            : "2px solid transparent",
        }}
        {...props}
      />
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={isSelected}
      disabled={disabled}
      onClick={() => { onValueChange(value); }}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      style={{
        backgroundColor: isSelected ? "var(--color-background)" : "transparent",
        color: isSelected ? "var(--color-foreground)" : "inherit",
        boxShadow: isSelected ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
      }}
      {...props}
    />
  );
});

TabsTrigger.displayName = "TabsTrigger";

export interface TabsContentProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Tab content panel
 */
const TabsContent = React.forwardRef<
  HTMLDivElement,
  TabsContentProps
>(({ className, value, ...props }, ref) => {
  const { value: selectedValue } = React.useContext(TabsContext);
  const isSelected = selectedValue === value;

  if (!isSelected) return null;

  return (
    <div
      ref={ref}
      role="tabpanel"
      className={cn(
        "mt-2",
        className,
      )}
      {...props}
    />
  );
});

TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
