import type {
  FontSize,
  FontWeight,
} from "./messageRenderingConfig";

/**
 * Font size as a raw `rem` length. Used to drive the content body via CSS
 * custom properties (`--chat-content-size`) — see MessageRenderingContext.
 * The class-based path (SIZE_CLASS) can't reach the `.prose` content
 * container because `.prose` / `.prose-sm` set `font-size` in styles.css and
 * win over utilities. Values mirror Tailwind's text-* scale so the
 * class-driven preview/header and the variable-driven content body agree.
 */
export const FONT_SIZE_REM: Record<FontSize, string> = {
  xxs: "0.625rem",
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  lg: "1.125rem",
};

/** Font weight as its numeric CSS value, for the `--chat-content-weight`
 *  custom property (same reasoning as FONT_SIZE_REM). */
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
