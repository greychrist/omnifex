import type React from "react";
import {
  isHexColor,
  resolveKind,
  type HiddenEventsStyle,
  type MessageRenderingConfig,
} from "./messageRenderingConfig";

/**
 * Hex alpha suffix for an opacity in percent — what every accent-derived
 * border (card outline, header divider, icon chip, side line) appends to its
 * swatch. Driven by Appearance › Global › Card border opacity.
 */
export function borderAlphaHex(opacityPct: number): string {
  const clamped = Math.max(0, Math.min(100, opacityPct));
  return Math.round((clamped / 100) * 255).toString(16).padStart(2, "0");
}

/** The kind's accent as a hex, or undefined when it is not one. */
export function swatchFor(
  config: MessageRenderingConfig,
  kindId: string,
): string | undefined {
  const ac = resolveKind(config, kindId).accentColor;
  return isHexColor(ac) ? ac : undefined;
}

/**
 * Inline border and background for a card, overriding Tailwind classes (the
 * unlayered `* { border-color }` rule in styles.css outranks every
 * border-colour utility). The border takes the configured opacity; the
 * background is a fixed ~8% (`14`) tint.
 */
export function accentStyleFor(
  config: MessageRenderingConfig,
  kindId: string,
): React.CSSProperties | undefined {
  const swatch = swatchFor(config, kindId);
  if (!swatch) return undefined;
  return {
    borderColor: `${swatch}${borderAlphaHex(config.cardBorderOpacity)}`,
    backgroundColor: `${swatch}14`,
  };
}

/**
 * Corner radius for a card-shaped frame (card, collapsible, permission and
 * question cards) — All cards › Corner radius. Inline, over the `rounded-lg`
 * class the shells keep as a fallback.
 */
export function cardRadiusStyle(config: MessageRenderingConfig): React.CSSProperties {
  return { borderRadius: `${String(config.cardBorderRadius)}px` };
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
  { background, border, headerText, detailText, borderOpacity }: HiddenEventsStyle,
  backdrop: string,
): HiddenEventsColors {
  const borderColor = hiddenEventsBorder(border, borderOpacity);
  const bar =
    background === null && borderColor === undefined
      ? undefined
      : {
          ...(background !== null && { backgroundColor: background }),
          ...(borderColor !== undefined && { borderColor }),
        };
  const auto = background === null ? undefined : readableOn(composite(background, backdrop));
  return {
    bar,
    header: headerText ?? auto,
    detail: detailText ?? (auto && `${auto}b3`),
  };
}

/**
 * The card border at its opacity. A configured colour keeps its hue and has its
 * own alpha (if any) scaled; with none configured the theme's border colour is
 * faded instead. Undefined — leave the theme's class alone — at 100% with no
 * colour.
 */
function hiddenEventsBorder(border: string | null, opacityPct: number): string | undefined {
  if (border === null) {
    return opacityPct >= 100
      ? undefined
      : `color-mix(in oklch, var(--color-border) ${String(opacityPct)}%, transparent)`;
  }
  if (opacityPct >= 100) return border;
  const { rgb, alpha } = parseHex(border);
  const hex = rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
  return `#${hex}${borderAlphaHex(alpha * opacityPct)}`;
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
