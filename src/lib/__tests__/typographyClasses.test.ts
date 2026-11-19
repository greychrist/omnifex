import { describe, it, expect } from "vitest";
import { createDefaultConfig } from "../messageRenderingConfig";
import { contentClassNames, FONT_SIZE_REM, FONT_WEIGHT_VALUE } from "../typographyClasses";
import type { TypographyStyle } from "../messageRenderingConfig";

/** The class names for a content style, through the config the app reads. */
const typographyClassNames = (content: TypographyStyle) =>
  contentClassNames({ ...createDefaultConfig(), typography: { content } });

describe("contentClassNames", () => {
  it("emits size + weight + italic, no family class", () => {
    const result = typographyClassNames({
      typeface: "inter",
      size: "base",
      weight: "bold",
      italic: true,
    });
    expect(result).toBe("text-base font-bold italic");
    expect(result).not.toMatch(/font-sans|font-serif|font-mono/);
  });

  it("omits italic when false", () => {
    const result = typographyClassNames({
      typeface: "inter",
      size: "sm",
      weight: "normal",
      italic: false,
    });
    expect(result).toBe("text-sm font-normal");
  });

  it("maps the xxs (extra extra small) size to the custom text-xxs class", () => {
    const result = typographyClassNames({
      typeface: "inter",
      size: "xxs",
      weight: "normal",
      italic: false,
    });
    expect(result).toBe("text-xxs font-normal");
  });

  it("maps every supported font weight to its Tailwind class", () => {
    const cases = [
      ["thin", "font-thin"],
      ["extralight", "font-extralight"],
      ["light", "font-light"],
      ["normal", "font-normal"],
      ["medium", "font-medium"],
      ["semibold", "font-semibold"],
      ["bold", "font-bold"],
      ["extrabold", "font-extrabold"],
      ["black", "font-black"],
    ] as const;
    for (const [weight, expected] of cases) {
      const result = typographyClassNames({
        typeface: "inter",
        size: "sm",
        weight,
        italic: false,
      });
      expect(result).toBe(`text-sm ${expected}`);
    }
  });
});

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
