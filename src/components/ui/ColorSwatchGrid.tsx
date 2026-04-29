import * as React from "react";
import { cn } from "@/lib/utils";

export const SWATCHES = [
  "#ef4444", // red
  "#f59e0b", // amber
  "#84cc16", // lime
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#a78bfa", // violet
  "#ec4899", // pink
  "#6b7280", // gray
];

export interface ColorSwatchGridProps {
  value: string;
  onChange: (color: string) => void;
}

export const ColorSwatchGrid: React.FC<ColorSwatchGridProps> = ({ value, onChange }) => {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SWATCHES.map((swatch) => (
        <button
          key={swatch}
          type="button"
          onClick={() => onChange(swatch)}
          className={cn(
            "w-[22px] h-[22px] rounded cursor-pointer transition-shadow",
            value.toLowerCase() === swatch.toLowerCase()
              ? "ring-2 ring-white ring-offset-0"
              : "ring-1 ring-white/10 hover:ring-white/30",
          )}
          style={{ backgroundColor: swatch }}
          aria-label={`Select color ${swatch}`}
        />
      ))}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-[22px] h-[22px] rounded cursor-pointer border border-border bg-transparent"
        title="Custom color"
      />
    </div>
  );
};
