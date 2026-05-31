import type React from "react";
import {
  isHexColor,
  resolveKind,
  resolveMessageStyle,
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

/**
 * Like {@link accentFor}, but resolves the kind's per-kind accent OVERRIDE on
 * top of the category base — not just the category base.
 *
 * Use this for cards rendered OUTSIDE a `MessageFrame` (the live prompts:
 * AskUserQuestionCard / PermissionCard). Inside a MessageFrame the injected
 * `effConfig` already carries the fully-cascaded style, so `accentFor` (category
 * base) is correct there and applying overrides again would double-apply. But a
 * live prompt uses the GLOBAL config, so `accentFor` drops the kind's catalog
 * accent and the card falls back to the category's muted/gray. Passing
 * `undefined` for the message means only `$kind` / `$category` conditions match
 * (content conditions need a message) — exactly the per-kind accent we want.
 */
export function resolvedAccentFor(
  config: MessageRenderingConfig,
  kindId: string,
): PaletteEntry | null {
  const ac = resolveMessageStyle(config, undefined, kindId).accentColor;
  if (isHexColor(ac)) {
    return { border: "", bg: "auto", swatch: ac };
  }
  return config.palette[ac as keyof typeof config.palette] ?? null;
}

export function resolvedAccentStyleFor(
  config: MessageRenderingConfig,
  kindId: string,
): React.CSSProperties | undefined {
  const entry = resolvedAccentFor(config, kindId);
  return entry ? accentStyleFromEntry(entry) : undefined;
}

export function resolvedSwatchFor(
  config: MessageRenderingConfig,
  kindId: string,
): string | undefined {
  return resolvedAccentFor(config, kindId)?.swatch;
}
