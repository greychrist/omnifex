import type React from "react";
import type { IconName, MessageRenderingConfig } from "./messageRenderingConfig";
import { accentStyleFor, swatchFor } from "./accentStyle";

export function headerLabelFor(
  config: MessageRenderingConfig,
  kindId: string,
): string | null {
  const kind = config.kinds[kindId];
  if (!kind) return null;
  return kind.headerLabel;
}

export function iconNameFor(
  config: MessageRenderingConfig,
  kindId: string,
): IconName | null {
  const kind = config.kinds[kindId];
  if (!kind) return null;
  return kind.icon;
}

export interface KindPresentation {
  headerLabel: string | null;
  iconName: IconName | null;
  style: React.CSSProperties | undefined;
  swatch: string | undefined;
}

export function presentationFor(
  config: MessageRenderingConfig,
  kindId: string,
): KindPresentation {
  return {
    headerLabel: headerLabelFor(config, kindId),
    iconName: iconNameFor(config, kindId),
    style: accentStyleFor(config, kindId),
    swatch: swatchFor(config, kindId),
  };
}
