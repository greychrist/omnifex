import type { TabIndicatorSize } from "./messageRenderingConfig";
import { isHexColor } from "./messageRenderingConfig";

/** Matches TAB_INDICATOR_SIZE_CLASS: dynamic `w-[${n}px]` strings can't be JIT'd. */
export const TAB_INDICATOR_PX: Record<TabIndicatorSize, number> = {
  sm: 14,
  md: 16,
  lg: 18,
};

export const TAB_INDICATOR_SIZE_CLASS: Record<TabIndicatorSize, string> = {
  sm: "w-[14px] h-[14px]",
  md: "w-4 h-4",
  lg: "w-[18px] h-[18px]",
};

/** Colors are hex (the config converts saved palette names on load); anything else falls back to grey. */
export function resolveIndicatorColor(color: string): string {
  return isHexColor(color) ? color : "#4b5563";
}
