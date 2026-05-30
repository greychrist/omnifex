import type { KindStyle } from "@/lib/messageRenderingConfig";

export type ChipBorderValue = "default" | "on" | "off";

/**
 * Map a resolved `iconBordered` tri-state to the chip-border dropdown value.
 * `undefined` means "inherit the global `typography.icon.bordered` default".
 */
export function chipBorderValue(resolved: boolean | undefined): ChipBorderValue {
  return resolved === undefined ? "default" : resolved ? "on" : "off";
}

/**
 * Map a chip-border dropdown selection to a style patch. "default" unsets the
 * field (the patch carries `undefined`) so it falls back to the global default.
 *
 * Critically this routes through the editor's `onChange` in BOTH category and
 * override mode — unlike the old "default" path, which called a per-field clear
 * handler that is undefined in category mode and therefore silently no-op'd.
 */
export function chipBorderPatch(value: ChipBorderValue): Pick<KindStyle, "iconBordered"> {
  return { iconBordered: value === "default" ? undefined : value === "on" };
}
