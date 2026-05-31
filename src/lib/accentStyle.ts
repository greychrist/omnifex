import type React from "react";
import {
  isHexColor,
  resolveKind,
  type MessageRenderingConfig,
  type PaletteEntry,
} from "./messageRenderingConfig";

// Build an inline style that overrides Tailwind border/bg classes for a card.
// Alpha suffixes: 55 (~33%) for the border, 14 (~8%) for the background. Chosen
// to roughly match the original `border-X/30 bg-X/5` look.
export function accentStyleFromEntry(entry: PaletteEntry): React.CSSProperties {
  return {
    borderColor: `${entry.swatch}55`,
    backgroundColor: entry.bg === null ? undefined : `${entry.swatch}14`,
  };
}

/**
 * Resolve the accent for a kind to a `PaletteEntry`-shaped record so the
 * downstream helpers (`accentStyleFor`, `swatchFor`) don't care whether
 * the value came from the named palette or a free-form hex from the
 * per-kind colour picker.
 *
 * `kind.accentColor` is `string` (loosened from `PaletteName` when the
 * picker landed). Two recognised forms:
 *   - Palette name (legacy / shared retinting) — looked up in
 *     `config.palette`.
 *   - Hex colour (`#rgb` / `#rrggbb` / `#rrggbbaa`) — synthesised into
 *     a PaletteEntry-like shape with the hex as the swatch and the
 *     border/bg alpha suffixes computed by `accentStyleFromEntry`.
 *
 * Anything else returns null and the caller renders without accent
 * styling.
 *
 * Uses `resolveKind` which cascades: category base → registry default →
 * user kind patch. The result is the fully-resolved per-kind accent.
 */
export function accentFor(
  config: MessageRenderingConfig,
  kindId: string,
): PaletteEntry | null {
  const ac = resolveKind(config, kindId).accentColor;
  if (isHexColor(ac)) {
    return { border: "", bg: "auto", swatch: ac };
  }
  return config.palette[ac as keyof typeof config.palette] ?? null;
}

export function accentStyleFor(
  config: MessageRenderingConfig,
  kindId: string,
): React.CSSProperties | undefined {
  const entry = accentFor(config, kindId);
  return entry ? accentStyleFromEntry(entry) : undefined;
}

export function swatchFor(
  config: MessageRenderingConfig,
  kindId: string,
): string | undefined {
  return accentFor(config, kindId)?.swatch;
}
