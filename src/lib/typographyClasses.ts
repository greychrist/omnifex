import type {
  FontFamily,
  FontSize,
  FontWeight,
  MessageRenderingConfig,
  TypographyStyle,
} from "./messageRenderingConfig";

const FAMILY_CLASS: Record<FontFamily, string> = {
  sans: "font-sans",
  serif: "font-serif",
  mono: "font-mono",
};

const SIZE_CLASS: Record<FontSize, string> = {
  xs: "text-xs",
  sm: "text-sm",
  base: "text-base",
  lg: "text-lg",
};

const WEIGHT_CLASS: Record<FontWeight, string> = {
  normal: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
  bold: "font-bold",
};

export function typographyClassNames(style: TypographyStyle): string {
  return [
    FAMILY_CLASS[style.family],
    SIZE_CLASS[style.size],
    WEIGHT_CLASS[style.weight],
    style.italic ? "italic" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function headerClassNames(config: MessageRenderingConfig): string {
  return typographyClassNames(config.typography.header);
}

export function contentClassNames(config: MessageRenderingConfig): string {
  return typographyClassNames(config.typography.content);
}
