import { describe, it, expect } from "vitest";
import { createDefaultConfig } from "../messageRenderingConfig";
import {
  contentClassNames,
  headerClassNames,
  iconWrapperClassName,
  iconWrapperStyle,
  typographyClassNames,
  typographyFontFamily,
} from "../typographyClasses";

describe("typographyClassNames", () => {
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

describe("typographyFontFamily", () => {
  it("returns the catalog cssFamily for known typefaces", () => {
    const inter = typographyFontFamily({
      typeface: "inter",
      size: "sm",
      weight: "normal",
      italic: false,
    });
    expect(inter).toMatch(/^"Inter",/);

    const geist = typographyFontFamily({
      typeface: "geist",
      size: "sm",
      weight: "normal",
      italic: false,
    });
    expect(geist).toMatch(/^"Geist",/);
  });
});

describe("headerClassNames / contentClassNames", () => {
  it("default config emits text-sm font-semibold for header (no italic)", () => {
    expect(headerClassNames(createDefaultConfig())).toBe("text-sm font-semibold");
  });

  it("default config emits text-sm font-normal for content", () => {
    expect(contentClassNames(createDefaultConfig())).toBe("text-sm font-normal");
  });
});

describe("typographyClasses (icon helpers)", () => {
  describe("iconWrapperClassName", () => {
    it("includes chip classes when bordered is true (default)", () => {
      const cfg = createDefaultConfig();
      const cls = iconWrapperClassName(cfg);
      expect(cls).toContain("border");
      expect(cls).toContain("rounded-md");
      expect(cls).toContain("p-1.5");
      expect(cls).toContain("-mt-1");
    });

    it("uses flat layout when bordered is false", () => {
      const cfg = createDefaultConfig();
      cfg.typography.icon.bordered = false;
      const cls = iconWrapperClassName(cfg);
      expect(cls).toContain("mt-0.5");
      expect(cls).not.toContain("border");
      expect(cls).not.toContain("rounded-md");
    });

    it("respects per-kind iconBordered override", () => {
      const cfg = createDefaultConfig();
      cfg.typography.icon.bordered = true;
      const firstKindId = Object.keys(cfg.kinds)[0];
      cfg.kinds[firstKindId].iconBordered = false;
      expect(iconWrapperClassName(cfg, firstKindId)).toContain("mt-0.5");
    });
  });

  describe("iconWrapperStyle", () => {
    it("returns undefined when no swatch and not bordered", () => {
      const cfg = createDefaultConfig();
      cfg.typography.icon.bordered = false;
      expect(iconWrapperStyle(cfg)).toBeUndefined();
    });

    it("sets color from swatch", () => {
      const cfg = createDefaultConfig();
      cfg.typography.icon.bordered = false;
      const style = iconWrapperStyle(cfg, "#abcdef");
      expect(style?.color).toBe("#abcdef");
    });

    it("sets borderColor and backgroundColor when bordered with swatch", () => {
      const cfg = createDefaultConfig();
      cfg.typography.icon.bordered = true;
      cfg.typography.icon.bgOpacity = 50;
      const style = iconWrapperStyle(cfg, "#abcdef");
      expect(style?.color).toBe("#abcdef");
      expect(style?.borderColor).toBe("#abcdef55");
      expect(style?.backgroundColor).toBe(
        "color-mix(in oklch, var(--color-background) 50%, transparent)",
      );
    });

    it("clamps bgOpacity below 0 to 0", () => {
      const cfg = createDefaultConfig();
      cfg.typography.icon.bordered = true;
      cfg.typography.icon.bgOpacity = -10;
      const style = iconWrapperStyle(cfg, "#000");
      expect(style?.backgroundColor).toContain("0%");
    });

    it("clamps bgOpacity above 100 to 100", () => {
      const cfg = createDefaultConfig();
      cfg.typography.icon.bordered = true;
      cfg.typography.icon.bgOpacity = 999;
      const style = iconWrapperStyle(cfg, "#000");
      expect(style?.backgroundColor).toContain("100%");
    });

    it("respects per-kind iconBgOpacity override", () => {
      const cfg = createDefaultConfig();
      cfg.typography.icon.bordered = true;
      cfg.typography.icon.bgOpacity = 100;
      const firstKindId = Object.keys(cfg.kinds)[0];
      cfg.kinds[firstKindId].iconBgOpacity = 25;
      const style = iconWrapperStyle(cfg, "#000", firstKindId);
      expect(style?.backgroundColor).toContain("25%");
    });

    it("returns bordered styling without color when no swatch", () => {
      const cfg = createDefaultConfig();
      cfg.typography.icon.bordered = true;
      const style = iconWrapperStyle(cfg);
      expect(style?.color).toBeUndefined();
      expect(style?.borderColor).toBeUndefined();
      expect(style?.backgroundColor).toBeDefined();
    });
  });
});
