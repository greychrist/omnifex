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
  value: string;
  onValueChange: (value: string) => void;
  variant?: TabsVariant;
  children: React.ReactNode;
  className?: string;
}

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
  title?: string;
}

const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  TabsTriggerProps
>(({ className, value, disabled, ...props }, ref) => {
  const { value: selectedValue, onValueChange, variant } = React.useContext(TabsContext);
  const isSelected = selectedValue === value;

  if (variant === "line") {
    // Inline borderBottom: Tailwind border-color utilities don't render in this build.
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
