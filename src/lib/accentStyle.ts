import type React from "react";
import {
  isHexColor,
  resolveKind,
  type HiddenEventsStyle,
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

/** Automatic text colours for the hidden-events bar — slate-50 and slate-900. */
export const LIGHT_TEXT = "#f8fafc";
export const DARK_TEXT = "#0f172a";

export interface HiddenEventsColors {
  bar: React.CSSProperties | undefined;
  header: string | undefined;
  detail: string | undefined;
}

/**
 * Inline colours for the compact-mode hidden-events bar. Undefined means
 * "leave the theme's class alone". Inline because the unlayered
 * `* { border-color }` rule in styles.css outranks every Tailwind border-colour
 * utility.
 *
 * Text left unset is automatic: once a background is set, whichever of
 * LIGHT_TEXT / DARK_TEXT contrasts more with it, the detail dimmed to ~70% so
 * the header still leads. The background is judged by what it composites to
 * over `backdrop` (the theme's background) — a faint white over the dark
 * theme is still dark, and must keep light text.
 */
export function hiddenEventsColors(
  { background, border, headerText, detailText }: HiddenEventsStyle,
  backdrop: string,
): HiddenEventsColors {
  const bar =
    background === null && border === null
      ? undefined
      : {
          ...(background !== null && { backgroundColor: background }),
          ...(border !== null && { borderColor: border }),
        };
  const auto = background === null ? undefined : readableOn(composite(background, backdrop));
  return {
    bar,
    header: headerText ?? auto,
    detail: detailText ?? (auto && `${auto}b3`),
  };
}

/**
 * The theme's background as a hex, for compositing a translucent bar colour.
 * Approximates `--color-background` per theme (oklch 0.18 gray / 0.98 light);
 * precision only matters for translucent backgrounds near the midpoint, and
 * the explicit text colours cover those.
 */
export function currentThemeBackdrop(): string {
  const light =
    typeof document !== "undefined" && document.documentElement.classList.contains("theme-light");
  return light ? "#f7f9fb" : "#12171c";
}

type Rgb = [number, number, number];

function parseHex(hex: string): { rgb: Rgb; alpha: number } {
  const h = hex.slice(1);
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { rgb: [n(0), n(2), n(4)], alpha: full.length === 8 ? n(6) / 255 : 1 };
}

function composite(fg: string, bg: string): Rgb {
  const { rgb, alpha } = parseHex(fg);
  const base = parseHex(bg).rgb;
  return rgb.map((c, i) => c * alpha + base[i] * (1 - alpha)) as Rgb;
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function readableOn(rgb: Rgb): string {
  const l = luminance(rgb);
  const vsLight = (luminance(parseHex(LIGHT_TEXT).rgb) + 0.05) / (l + 0.05);
  const vsDark = (l + 0.05) / (luminance(parseHex(DARK_TEXT).rgb) + 0.05);
  return vsLight >= vsDark ? LIGHT_TEXT : DARK_TEXT;
}
