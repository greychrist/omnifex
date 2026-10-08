import { describe, it, expect } from "vitest";
import { createDefaultConfig } from "../messageRenderingConfig";
import { accentStyleFor, borderAlphaHex, DARK_TEXT, hiddenEventsColors, LIGHT_TEXT, swatchFor } from "../accentStyle";

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

describe("hiddenEventsColors", () => {
  const DARK = "#12171c";
  const LIGHT = "#f7f9fb";
  const unset = { background: null, border: null, headerText: null, detailText: null, borderOpacity: 100, borderRadius: 8 };

  it("sets nothing when nothing is configured, so the bar keeps its theme look", () => {
    expect(hiddenEventsColors(unset, DARK)).toEqual({ bar: undefined, header: undefined, detail: undefined });
  });

  it("puts bar colours on the bar, only the ones configured", () => {
    expect(hiddenEventsColors({ ...unset, border: "#60a5fa" }, DARK).bar).toEqual({ borderColor: "#60a5fa" });
    expect(hiddenEventsColors({ ...unset, background: "#1e293b", border: "#60a5fa" }, DARK).bar)
      .toEqual({ backgroundColor: "#1e293b", borderColor: "#60a5fa" });
  });

  // Border opacity scales the border colour's own alpha; on the theme's border
  // (no colour set) it fades the theme colour instead. 100% changes nothing.
  it("applies border opacity to a configured border, multiplying any alpha it carries", () => {
    expect(hiddenEventsColors({ ...unset, border: "#3f6578", borderOpacity: 50 }, DARK).bar)
      .toEqual({ borderColor: "#3f657880" });
    // #60a5fa80 is 50% already; at 50% opacity it lands on 25% (0x40).
    expect(hiddenEventsColors({ ...unset, border: "#60a5fa80", borderOpacity: 50 }, DARK).bar)
      .toEqual({ borderColor: "#60a5fa40" });
    expect(hiddenEventsColors({ ...unset, border: "#abc", borderOpacity: 20 }, DARK).bar)
      .toEqual({ borderColor: "#aabbcc33" });
  });

  it("fades the theme border when no border colour is set", () => {
    expect(hiddenEventsColors({ ...unset, borderOpacity: 40 }, DARK).bar)
      .toEqual({ borderColor: "color-mix(in oklch, var(--color-border) 40%, transparent)" });
  });

  it("picks dark text on a light background and light text on a dark one", () => {
    expect(hiddenEventsColors({ ...unset, background: "#fde68a" }, DARK).header).toBe(DARK_TEXT);
    expect(hiddenEventsColors({ ...unset, background: "#1e293b" }, LIGHT).header).toBe(LIGHT_TEXT);
  });

  // A translucent background is mostly the theme showing through: faint white
  // over the dark theme is still dark, so the text must stay light.
  it("judges a translucent background by what it composites to over the theme", () => {
    expect(hiddenEventsColors({ ...unset, background: "#ffffff20" }, DARK).header).toBe(LIGHT_TEXT);
    expect(hiddenEventsColors({ ...unset, background: "#00000020" }, LIGHT).header).toBe(DARK_TEXT);
  });

  it("dims the automatic detail text so the header still leads", () => {
    expect(hiddenEventsColors({ ...unset, background: "#fde68a" }, DARK).detail).toBe(`${DARK_TEXT}b3`);
  });

  it("lets an explicit text colour win, each independently", () => {
    const c = hiddenEventsColors({ ...unset, background: "#fde68a", headerText: "#ff0000" }, DARK);
    expect(c.header).toBe("#ff0000");
    expect(c.detail).toBe(`${DARK_TEXT}b3`);
    expect(hiddenEventsColors({ ...unset, detailText: "#00ff00" }, DARK))
      .toEqual({ bar: undefined, header: undefined, detail: "#00ff00" });
  });
});
