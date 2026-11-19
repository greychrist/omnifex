import { describe, it, expect } from "vitest";
import { createDefaultConfig } from "../messageRenderingConfig";
import { accentStyleFor, borderAlphaHex, swatchFor } from "../accentStyle";

describe("accentStyle", () => {
  describe("swatchFor", () => {
    it("resolves a kind's hex accent through the cascade", () => {
      const cfg = createDefaultConfig();
      expect(swatchFor(cfg, "user.prompt")).toBe("#60a5fa"); // user category default
    });

    it("resolves accent for a kind via category when it has no override", () => {
      const cfg = createDefaultConfig();
      expect(swatchFor(cfg, "attachment.todo_reminder"))
        .toBe(swatchFor(cfg, "attachment.diagnostics"));
    });

    it("returns undefined when the accent is not a hex", () => {
      const cfg = createDefaultConfig();
      // mergeConfig would have converted or stripped this; set directly to
      // verify the helper's tolerance.
      cfg.categories.user.accentColor = "neon";
      expect(swatchFor(cfg, "user.prompt")).toBeUndefined();
      expect(accentStyleFor(cfg, "user.prompt")).toBeUndefined();
    });
  });

  describe("accentStyleFor", () => {
    it("derives borderColor / backgroundColor with alpha suffixes from the swatch", () => {
      const cfg = createDefaultConfig();
      cfg.categories.user.accentColor = "#a855f7";
      const style = accentStyleFor(cfg, "user.prompt");
      // 20% border alpha (`33`, the default cardBorderOpacity) and 8% bg
      // alpha (`14`).
      expect(style?.borderColor).toBe("#a855f733");
      expect(style?.backgroundColor).toBe("#a855f714");
    });
  });

  describe("border opacity", () => {
    it("follows the card border opacity setting", () => {
      const cfg = createDefaultConfig();
      cfg.categories.user.accentColor = "#a855f7";
      cfg.cardBorderOpacity = 35; // 0.35 * 255 = 89 = 0x59
      expect(accentStyleFor(cfg, "user.prompt")?.borderColor).toBe("#a855f759");
      cfg.cardBorderOpacity = 0;
      expect(accentStyleFor(cfg, "user.prompt")?.borderColor).toBe("#a855f700");
      cfg.cardBorderOpacity = 100;
      expect(accentStyleFor(cfg, "user.prompt")?.borderColor).toBe("#a855f7ff");
    });

    it("converts percent to a two-digit hex alpha", () => {
      expect(borderAlphaHex(20)).toBe("33");
      expect(borderAlphaHex(5)).toBe("0d");
    });
  });

  describe("accentStyleFor (cascade-aware via resolveKind)", () => {
    it("applies the registry default accent for a live card kind", () => {
      const cfg = createDefaultConfig();
      expect(swatchFor(cfg, "permission.request")).toBe("#f59e0b"); // amber registry default
      expect(accentStyleFor(cfg, "permission.request")?.borderColor).toBe("#f59e0b33");
    });
    it("honors a user kind patch over the registry default", () => {
      const cfg = createDefaultConfig();
      cfg.kinds["permission.request"] = { accentColor: "#123456" };
      expect(swatchFor(cfg, "permission.request")).toBe("#123456");
    });
  });
});
