import type React from "react";
import type {
  FontSize,
  FontWeight,
  MessageRenderingConfig,
  TypographyStyle,
} from "./messageRenderingConfig";
import { resolveTypeface } from "./typefaceCatalog";
import { resolveKind } from "./messageRenderingConfig";

const SIZE_CLASS: Record<FontSize, string> = {
  xs: "text-xs",
  sm: "text-sm",
  base: "text-base",
  lg: "text-lg",
};

const WEIGHT_CLASS: Record<FontWeight, string> = {
  thin: "font-thin",
  extralight: "font-extralight",
  light: "font-light",
  normal: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
  bold: "font-bold",
  extrabold: "font-extrabold",
  black: "font-black",
};

export function typographyClassNames(style: TypographyStyle): string {
  return [
    SIZE_CLASS[style.size],
    WEIGHT_CLASS[style.weight],
    style.italic ? "italic" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * CSS `font-family` value for a typography style. Pair with
 * `typographyClassNames` and apply via `style={{ fontFamily: ... }}`.
 */
export function typographyFontFamily(style: TypographyStyle): string {
  return resolveTypeface(style.typeface).cssFamily;
}

export function headerClassNames(config: MessageRenderingConfig): string {
  return typographyClassNames(config.typography.header);
}

export function contentClassNames(config: MessageRenderingConfig): string {
  return typographyClassNames(config.typography.content);
}

function resolveIconBordered(config: MessageRenderingConfig, kindId?: string): boolean {
  const kind = kindId ? resolveKind(config, kindId) : undefined;
  return kind?.iconBordered ?? config.typography.icon.bordered;
}

function resolveIconBgOpacity(config: MessageRenderingConfig, kindId?: string): number {
  const kind = kindId ? resolveKind(config, kindId) : undefined;
  return kind?.iconBgOpacity ?? config.typography.icon.bgOpacity;
}

/**
 * Tailwind classes for the wrapper around each card icon.
 *
 * When `typography.icon.bordered` is true, the wrapper renders as a chip
 * (`border rounded-md p-1.5`). Pair with `iconWrapperStyle()` for the
 * swatch-tinted border + opacity-controlled chat-background fill.
 *
 * When false, only the layout primitives stay — the icon sits flat against
 * the card background, no chip.
 *
 * In both cases `mt-0.5` nudges the icon down to align with the first text
 * line, and `shrink-0` keeps the wrapper from collapsing when body text
 * wraps.
 */
export function iconWrapperClassName(config: MessageRenderingConfig, kindId?: string): string {
  const base = "flex items-center justify-center shrink-0";
  // When bordered, negative margins offset the chip outward from its layout
  // box by exactly the chip's padding — net effect is that the icon glyph
  // itself stays in the same position relative to the card whether the chip
  // is on or off, while the chip border + bg extend visually around it.
  // Vertical math: -mt-1 (-4px) + p-1.5 (+6px) = +2px = the same as the
  // non-bordered `mt-0.5` nudge that aligns the icon with the first text
  // line. Horizontal: -mx-1.5 (-6px) + p-1.5 (+6px) = 0, so the icon's
  // left edge stays at the column edge.
  return resolveIconBordered(config, kindId)
    ? `${base} -mt-1 -mx-1.5 -mb-1.5 border rounded-md p-1.5`
    : `${base} mt-0.5`;
}

/**
 * Inline style for the chip wrapper. Returns:
 *  - `color` from the swatch (for the icon itself, since IconRenderer
 *    inherits via currentColor)
 *  - `borderColor` from the swatch + 33% alpha (matches card accent)
 *  - `backgroundColor` from `--background` mixed with transparent at the
 *    user's `bgOpacity` setting, so the chip punches through the card's
 *    tinted accent at the chosen opacity
 *
 * Returns undefined when there is nothing to apply (e.g. unbordered + no
 * swatch). Always pair with `iconWrapperClassName(config)`.
 */
export function iconWrapperStyle(
  config: MessageRenderingConfig,
  swatch?: string | null,
  kindId?: string,
): React.CSSProperties | undefined {
  const bordered = resolveIconBordered(config, kindId);
  const style: React.CSSProperties = {};
  if (swatch) style.color = swatch;
  if (bordered) {
    if (swatch) style.borderColor = `${swatch}55`;
    const op = Math.max(0, Math.min(100, resolveIconBgOpacity(config, kindId)));
    style.backgroundColor = `color-mix(in oklch, var(--color-background) ${op}%, transparent)`;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}
