import { describe, it, expect } from "vitest";
import { FONT_SIZE_REM, FONT_WEIGHT_VALUE } from "../typographyClasses";

describe("FONT_SIZE_REM / FONT_WEIGHT_VALUE", () => {
  it("maps every font size to a rem length, including xxs", () => {
    expect(FONT_SIZE_REM).toEqual({
      xxs: "0.625rem",
      xs: "0.75rem",
      sm: "0.875rem",
      base: "1rem",
      lg: "1.125rem",
    });
  });

  it("maps every font weight to its numeric CSS value", () => {
    expect(FONT_WEIGHT_VALUE).toEqual({
      thin: 100,
      extralight: 200,
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      extrabold: 800,
      black: 900,
    });
  });
});
