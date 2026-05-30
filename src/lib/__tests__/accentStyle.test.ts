import { describe, it, expect } from "vitest";
import { createDefaultConfig } from "../messageRenderingConfig";
import { accentFor, accentStyleFor, swatchFor } from "../accentStyle";

describe("accentStyle", () => {
  describe("accentFor", () => {
    it("resolves a palette name through config.palette", () => {
      const cfg = createDefaultConfig();
      // user.prompt resolves to accentColor: 'blue', palette.blue.swatch = #60a5fa
      const entry = accentFor(cfg, "user.prompt");
      expect(entry?.swatch).toBe("#60a5fa");
    });

    it("synthesises an entry from a hex accentColor (picker-driven)", () => {
      const cfg = createDefaultConfig();
      // The helper reads the resolved kind's accent — in production that's the
      // cascaded style injected as the category base, so set the category here.
      cfg.categories.user.accentColor = "#a855f7";
      const entry = accentFor(cfg, "user.prompt");
      expect(entry?.swatch).toBe("#a855f7");
      // Synthesised hex entries always opt into the bg tint (bg ≠ null).
      expect(entry?.bg).not.toBeNull();
    });

    it("resolves accent for a kind via category when it has no override", () => {
      const cfg = createDefaultConfig();
      // attachment.todo_reminder has no override -> attachment category (muted)
      expect(swatchFor(cfg, "attachment.todo_reminder"))
        .toBe(swatchFor(cfg, "attachment.diagnostics"));
    });

    it("returns null when accentColor isn't a known palette name or hex", () => {
      const cfg = createDefaultConfig();
      // mergeConfig would have stripped this; we set it directly to
      // verify the helper's tolerance.
      cfg.categories.user.accentColor = "neon";
      expect(accentFor(cfg, "user.prompt")).toBeNull();
    });
  });

  describe("accentStyleFor", () => {
    it("derives borderColor / backgroundColor with alpha suffixes from the swatch", () => {
      const cfg = createDefaultConfig();
      cfg.categories.user.accentColor = "#a855f7";
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
      cfg.categories.user.accentColor = "#123456";
      expect(swatchFor(cfg, "user.prompt")).toBe("#123456");
    });

    it("returns the palette swatch for a palette-name accentColor", () => {
      const cfg = createDefaultConfig();
      expect(swatchFor(cfg, "user.prompt")).toBe("#60a5fa");
    });
  });
});
