import React from "react";
import type { TabIndicators, TabIndicatorStyle, Palette } from "@/lib/messageRenderingConfig";
import { resolveIndicatorColor, TAB_INDICATOR_SIZE_CLASS } from "@/lib/tabIndicatorStyle";
import { IconRenderer } from "@/components/settings-panels/appearance/iconMap";

/**
 * One configurable tab status glyph. Icon + color come from the per-state
 * TabIndicatorStyle; size and the optional bordered chip are shared chrome
 * (config.tabIndicators). Always flashes (animate-pulse) so a background tab
 * that needs you catches the eye — the job the old pulsing dot did.
 *
 * Shared by the tab strip (TabManager) and the settings live-preview so the
 * two can never drift.
 */
export const TabStatusGlyph: React.FC<{
  style: TabIndicatorStyle;
  indicators: TabIndicators;
  palette: Palette;
  ariaLabel: string;
  /**
   * Opt out of the pulse. Flashing is right for "I need you now" and wrong for
   * an ambient countdown, which would otherwise strobe for minutes on end.
   */
  pulse?: boolean;
  /** Override the configured color — used to redden the cache glyph at its
   *  critical step without a second configurable entry. */
  colorOverride?: string;
}> = ({ style, indicators, palette, ariaLabel, pulse = true, colorOverride }) => {
  const color = colorOverride
    ? resolveIndicatorColor(colorOverride, palette)
    : resolveIndicatorColor(style.color, palette);
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
