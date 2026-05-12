import { describe, it, expect } from "vitest";
import { createDefaultConfig } from "../messageRenderingConfig";
import { accentFor, accentStyleFor, swatchFor } from "../accentStyle";

describe("accentStyle", () => {
  describe("accentFor", () => {
    it("resolves a palette name through config.palette", () => {
      const cfg = createDefaultConfig();
      // user.prompt defaults to accentColor: 'blue', palette.blue.swatch = #60a5fa
      const entry = accentFor(cfg, "user.prompt");
      expect(entry?.swatch).toBe("#60a5fa");
    });

    it("synthesises an entry from a hex accentColor (picker-driven)", () => {
      const cfg = createDefaultConfig();
      cfg.kinds["user.prompt"].accentColor = "#a855f7";
      const entry = accentFor(cfg, "user.prompt");
      expect(entry?.swatch).toBe("#a855f7");
      // Synthesised hex entries always opt into the bg tint (bg ≠ null).
      expect(entry?.bg).not.toBeNull();
    });

    it("returns null for an unknown kind id", () => {
      const cfg = createDefaultConfig();
      expect(accentFor(cfg, "no.such.kind")).toBeNull();
    });

    it("returns null when accentColor isn't a known palette name or hex", () => {
      const cfg = createDefaultConfig();
      // mergeConfig would have stripped this; we set it directly to
      // verify the helper's tolerance.
      cfg.kinds["user.prompt"].accentColor = "neon";
      expect(accentFor(cfg, "user.prompt")).toBeNull();
    });
  });

  describe("accentStyleFor", () => {
    it("derives borderColor / backgroundColor with alpha suffixes from the swatch", () => {
      const cfg = createDefaultConfig();
      cfg.kinds["user.prompt"].accentColor = "#a855f7";
      const style = accentStyleFor(cfg, "user.prompt");
      // 33% border alpha (`55`) and 8% bg alpha (`14`) — matches the
      // legacy `border-X/30 bg-X/5` look.
      expect(style?.borderColor).toBe("#a855f755");
      expect(style?.backgroundColor).toBe("#a855f714");
    });
  });

  describe("swatchFor", () => {
    it("returns the same hex passed in via accentColor", () => {
      const cfg = createDefaultConfig();
      cfg.kinds["user.prompt"].accentColor = "#123456";
      expect(swatchFor(cfg, "user.prompt")).toBe("#123456");
    });

    it("returns the palette swatch for a palette-name accentColor", () => {
      const cfg = createDefaultConfig();
      expect(swatchFor(cfg, "user.prompt")).toBe("#60a5fa");
    });
  });
});
