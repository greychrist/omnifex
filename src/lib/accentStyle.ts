import type React from "react";
import type {
  MessageRenderingConfig,
  PaletteEntry,
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

export function accentFor(
  config: MessageRenderingConfig,
  kindId: string,
): PaletteEntry | null {
  const kind = config.kinds[kindId];
  if (!kind) return null;
  return config.palette[kind.accentColor] ?? null;
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
