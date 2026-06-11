import type { Palette, TabIndicatorSize } from "./messageRenderingConfig";
import { isHexColor, DEFAULT_PALETTE } from "./messageRenderingConfig";

/** Shared glyph size → pixel edge. Matches the literal Tailwind classes in
 *  TAB_INDICATOR_SIZE_CLASS (dynamic `w-[${n}px]` strings can't be JIT'd). */
export const TAB_INDICATOR_PX: Record<TabIndicatorSize, number> = {
  sm: 14,
  md: 16,
  lg: 18,
};

/** Literal size classes (JIT-safe) for the IconRenderer className. */
export const TAB_INDICATOR_SIZE_CLASS: Record<TabIndicatorSize, string> = {
  sm: "w-[14px] h-[14px]",
  md: "w-4 h-4",
  lg: "w-[18px] h-[18px]",
};

/**
 * Resolve a tab-indicator color (a palette name OR a hex string, same form as
 * a kind's accentColor) to a concrete CSS color, against the user's possibly
 * retinted palette. Falls back to the neutral `muted` swatch for unknown names.
 */
export function resolveIndicatorColor(color: string, palette: Palette): string {
  if (isHexColor(color)) return color;
  return palette[color as keyof Palette]?.swatch ?? DEFAULT_PALETTE.muted.swatch;
}
