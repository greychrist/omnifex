import type React from "react";
import type { IconName, MessageRenderingConfig } from "./messageRenderingConfig";
import { resolveKind } from "./messageRenderingConfig";
import { accentStyleFor, swatchFor } from "./accentStyle";

export function headerLabelFor(
  config: MessageRenderingConfig,
  kindId: string,
): string | null {
  return resolveKind(config, kindId).headerLabel;
}

export function iconNameFor(
  config: MessageRenderingConfig,
  kindId: string,
): IconName | null {
  return resolveKind(config, kindId).icon;
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
