import type { TabIndicatorSize } from "./messageRenderingConfig";
import { isHexColor } from "./messageRenderingConfig";

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
 * A tab-indicator colour as CSS. Colours are hex — the config converts a saved
 * palette name on load — so anything else falls back to neutral grey.
 */
export function resolveIndicatorColor(color: string): string {
  return isHexColor(color) ? color : "#4b5563";
}
