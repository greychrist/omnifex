import type React from "react";
import {
  isHexColor,
  resolveKind,
  type MessageRenderingConfig,
} from "./messageRenderingConfig";

export function borderAlphaHex(opacityPct: number): string {
  const clamped = Math.max(0, Math.min(100, opacityPct));
  return Math.round((clamped / 100) * 255).toString(16).padStart(2, "0");
}

export function swatchFor(
  config: MessageRenderingConfig,
  kindId: string,
): string | undefined {
  const ac = resolveKind(config, kindId).accentColor;
  return isHexColor(ac) ? ac : undefined;
}

/** Inline: the unlayered `* { border-color }` rule in styles.css outranks every border-color utility. */
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

export function cardRadiusStyle(config: MessageRenderingConfig): React.CSSProperties {
  return { borderRadius: `${String(config.cardBorderRadius)}px` };
}
