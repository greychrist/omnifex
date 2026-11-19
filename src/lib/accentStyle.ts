import type React from "react";
import {
  isHexColor,
  resolveKind,
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
 * border-color utility). The border takes the configured opacity; the
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
