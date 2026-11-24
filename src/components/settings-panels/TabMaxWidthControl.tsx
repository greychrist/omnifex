import React from "react";
import { TAB_MAX_WIDTH_RANGE } from "@/lib/messageRenderingConfig";

export const TabMaxWidthControl: React.FC<{
  maxWidth: number;
  onChange: (maxWidth: number) => void;
}> = ({ maxWidth, onChange }) => (
  <div className="flex items-center gap-2 w-56">
    <input
      aria-label="Max tab width"
      type="range"
      min={TAB_MAX_WIDTH_RANGE.min}
      max={TAB_MAX_WIDTH_RANGE.max}
      step={TAB_MAX_WIDTH_RANGE.step}
      value={maxWidth}
      onChange={(e) => { onChange(parseInt(e.target.value, 10)); }}
      className="flex-1 cursor-pointer accent-foreground"
    />
    <span className="font-mono text-caption text-muted-foreground w-12 text-right">
      {maxWidth}px
    </span>
  </div>
);
