import React from "react";
import type { TabDensity } from "@/lib/messageRenderingConfig";
import { cn } from "@/lib/utils";

const OPTIONS: { value: TabDensity; label: string }[] = [
  { value: "expanded", label: "Expanded" },
  { value: "compact", label: "Compact" },
];

export const TabDensityControl: React.FC<{
  density: TabDensity;
  onChange: (density: TabDensity) => void;
}> = ({ density, onChange }) => (
  <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg">
    {OPTIONS.map(({ value, label }) => (
      <button
        key={value}
        type="button"
        aria-pressed={density === value}
        onClick={() => { onChange(value); }}
        className={cn(
          "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
          density === value ? "bg-background shadow-sm" : "hover:bg-background/50",
        )}
      >
        {label}
      </button>
    ))}
  </div>
);
