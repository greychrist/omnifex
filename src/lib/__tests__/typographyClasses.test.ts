import { describe, it, expect } from "vitest";
import { createDefaultConfig } from "../messageRenderingConfig";
import {
  contentClassNames,
  headerClassNames,
  iconSizeClassName,
  iconWrapperClassName,
  iconWrapperStyle,
  typographyClassNames,
} from "../typographyClasses";

describe("typographyClasses", () => {
  it("maps the default header style to expected Tailwind classes", () => {
    const cfg = createDefaultConfig();
    expect(headerClassNames(cfg)).toBe("font-sans text-sm font-semibold");
  });

  it("maps the default content style to expected Tailwind classes", () => {
    const cfg = createDefaultConfig();
    expect(contentClassNames(cfg)).toBe("font-sans text-sm font-normal");
  });

  it("includes italic when italic is true", () => {
    const cls = typographyClassNames({
      family: "serif",
      size: "lg",
      weight: "bold",
      italic: true,
    });
    expect(cls).toBe("font-serif text-lg font-bold italic");
  });

  it("omits italic when italic is false", () => {
    const cls = typographyClassNames({
      family: "mono",
      size: "xs",
      weight: "medium",
      italic: false,
    });
    expect(cls).toBe("font-mono text-xs font-medium");
  });

  describe("iconSizeClassName", () => {
    it("returns the global icon size class when no kindId is given", () => {
      const cfg = createDefaultConfig();
      // default icon.size is "base"
      expect(iconSizeClassName(cfg)).toBe("h-5 w-5");
    });

    it("returns the kind override when iconSize is set on the kind", () => {
      const cfg = createDefaultConfig();
      const firstKindId = Object.keys(cfg.kinds)[0]!;
      cfg.kinds[firstKindId]!.iconSize = "xl";
      expect(iconSizeClassName(cfg, firstKindId)).toBe("h-8 w-8");
    });

    it("falls back to global when kindId is unknown", () => {
      const cfg = createDefaultConfig();
      cfg.typography.icon.size = "lg";
      expect(iconSizeClassName(cfg, "totally.unknown.kind")).toBe("h-6 w-6");
    });

    it("maps every icon size correctly", () => {
      const cfg = createDefaultConfig();
      const cases = [
        ["xs", "h-3.5 w-3.5"],
        ["sm", "h-4 w-4"],
        ["base", "h-5 w-5"],
        ["lg", "h-6 w-6"],
        ["xl", "h-8 w-8"],
      ] as const;
      for (const [size, expected] of cases) {
        cfg.typography.icon.size = size;
        expect(iconSizeClassName(cfg)).toBe(expected);
      }
    });
  });

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
      const firstKindId = Object.keys(cfg.kinds)[0]!;
      cfg.kinds[firstKindId]!.iconBordered = false;
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
      const firstKindId = Object.keys(cfg.kinds)[0]!;
      cfg.kinds[firstKindId]!.iconBgOpacity = 25;
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
