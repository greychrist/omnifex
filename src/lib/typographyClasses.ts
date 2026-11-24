import type {
  FontSize,
  FontWeight,
} from "./messageRenderingConfig";

/** Drives `--chat-content-size`: `.prose` sets font-size in styles.css and beats utility classes. Mirrors Tailwind's text-* scale. */
export const FONT_SIZE_REM: Record<FontSize, string> = {
  xxs: "0.625rem",
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  lg: "1.125rem",
};

export const FONT_WEIGHT_VALUE: Record<FontWeight, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};
