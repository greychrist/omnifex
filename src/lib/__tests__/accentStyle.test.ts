import { describe, it, expect } from "vitest";
import { createDefaultConfig } from "../messageRenderingConfig";
import { accentFor, accentStyleFor, DARK_TEXT, hiddenEventsColors, LIGHT_TEXT, swatchFor } from "../accentStyle";

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

  describe("accentStyleFor (cascade-aware via resolveKind)", () => {
    it("applies the registry default accent for a live card kind", () => {
      const cfg = createDefaultConfig();
      expect(swatchFor(cfg, "permission.request")).toBe("#f59e0b"); // amber registry default
      expect(accentStyleFor(cfg, "permission.request")?.borderColor).toBe("#f59e0b55");
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
  const unset = { background: null, border: null, headerText: null, detailText: null };

  it("sets nothing when nothing is configured, so the bar keeps its theme look", () => {
    expect(hiddenEventsColors(unset, DARK)).toEqual({ bar: undefined, header: undefined, detail: undefined });
  });

  it("puts bar colours on the bar, only the ones configured", () => {
    expect(hiddenEventsColors({ ...unset, border: "#60a5fa" }, DARK).bar).toEqual({ borderColor: "#60a5fa" });
    expect(hiddenEventsColors({ ...unset, background: "#1e293b", border: "#60a5fa" }, DARK).bar)
      .toEqual({ backgroundColor: "#1e293b", borderColor: "#60a5fa" });
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
