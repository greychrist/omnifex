import React from "react";
import type { TabIndicators, TabIndicatorStyle } from "@/lib/messageRenderingConfig";
import { resolveIndicatorColor, TAB_INDICATOR_SIZE_CLASS } from "@/lib/tabIndicatorStyle";
import { IconRenderer } from "@/components/settings-panels/appearance/iconMap";

/** Shared by the tab strip and the settings preview so the two never drift. */
export const TabStatusGlyph: React.FC<{
  style: TabIndicatorStyle;
  indicators: TabIndicators;
  ariaLabel: string;
  /** Off for ambient countdowns, which would otherwise strobe for minutes. */
  pulse?: boolean;
  colorOverride?: string;
}> = ({ style, indicators, ariaLabel, pulse = true, colorOverride }) => {
  const color = resolveIndicatorColor(colorOverride ?? style.color);
  const glyph = (
    <IconRenderer name={style.icon} className={TAB_INDICATOR_SIZE_CLASS[indicators.size]} />
  );
  if (!indicators.bordered) {
    return (
      <span
        aria-label={ariaLabel}
        className={pulse ? "inline-flex animate-pulse" : "inline-flex"}
        style={{ color }}
      >
        {glyph}
      </span>
    );
  }
  const op = Math.max(0, Math.min(100, indicators.bgOpacity));
  return (
    <span
      aria-label={ariaLabel}
      className={
        pulse
          ? "inline-flex items-center justify-center rounded-sm border p-0.5 animate-pulse"
          : "inline-flex items-center justify-center rounded-sm border p-0.5"
      }
      style={{
        color,
        borderColor: `${color}55`,
        backgroundColor: `color-mix(in oklch, var(--color-background) ${op}%, transparent)`,
      }}
    >
      {glyph}
    </span>
  );
};
