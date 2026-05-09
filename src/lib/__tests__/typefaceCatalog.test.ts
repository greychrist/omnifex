import { describe, it, expect } from "vitest";
import {
  TYPEFACE_CATALOG,
  TYPEFACE_BY_ID,
  APP_FONT_CHOICES,
  isTypefaceId,
  resolveTypeface,
  type Typeface,
} from "../typefaceCatalog";

describe("typefaceCatalog", () => {
  it("ships exactly 13 entries", () => {
    expect(TYPEFACE_CATALOG).toHaveLength(13);
  });

  it("every entry has the required fields", () => {
    for (const t of TYPEFACE_CATALOG) {
      expect(t.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.cssFamily.length).toBeGreaterThan(0);
      expect(["sans", "display-sans", "serif", "humanist", "mono"]).toContain(t.family);
      expect(t.fallback.length).toBeGreaterThan(0);
    }
  });

  it("ids are unique", () => {
    const ids = TYPEFACE_CATALOG.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("TYPEFACE_BY_ID round-trips every catalog entry", () => {
    for (const t of TYPEFACE_CATALOG) {
      expect(TYPEFACE_BY_ID[t.id]).toBe(t);
    }
  });

  it("APP_FONT_CHOICES includes only sans / display-sans typefaces", () => {
    for (const t of APP_FONT_CHOICES) {
      expect(["sans", "display-sans"]).toContain(t.family);
    }
    // And every sans-tagged catalog entry shows up in APP_FONT_CHOICES.
    const sansIds = TYPEFACE_CATALOG
      .filter((t) => t.family === "sans" || t.family === "display-sans")
      .map((t) => t.id);
    const choiceIds = APP_FONT_CHOICES.map((t) => t.id);
    expect(choiceIds.sort()).toEqual(sansIds.sort());
  });

  it("isTypefaceId narrows correctly", () => {
    expect(isTypefaceId("inter")).toBe(true);
    expect(isTypefaceId("not-a-real-font")).toBe(false);
    expect(isTypefaceId("")).toBe(false);
  });

  it("resolveTypeface returns the entry for known ids", () => {
    expect(resolveTypeface("inter").id).toBe("inter");
    expect(resolveTypeface("geist").id).toBe("geist");
  });

  it("resolveTypeface falls back to inter for unknown ids", () => {
    expect(resolveTypeface("nope" as Typeface).id).toBe("inter");
  });
});
