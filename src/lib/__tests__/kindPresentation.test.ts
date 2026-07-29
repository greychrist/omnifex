import { describe, it, expect } from "vitest";
import { createDefaultConfig, resolveKind } from "../messageRenderingConfig";
import { headerLabelFor, iconNameFor, presentationFor } from "../kindPresentation";

describe("kindPresentation", () => {
  it("returns the configured headerLabel for a known kind", () => {
    const cfg = createDefaultConfig();
    expect(headerLabelFor(cfg, "user.prompt")).toBe("You");
    // v2 catalog: assistant.tool-use and cli-stream-result have no headerLabel (null).
    expect(headerLabelFor(cfg, "cli-stream-result")).toBeNull();
    expect(headerLabelFor(cfg, "cli-stream-init")).toBeNull();
  });

  it("returns null when the kind's category headerLabel is null", () => {
    const cfg = createDefaultConfig();
    // The system category has headerLabel: null (no header shown); the helper
    // reads the category base (= the cascaded style in production).
    expect(headerLabelFor(cfg, "system.informational")).toBeNull();
  });

  it("returns the category headerLabel for a kind", () => {
    const cfg = createDefaultConfig();
    cfg.categories.agent.headerLabel = "Claude Code";
    expect(headerLabelFor(cfg, "assistant.text")).toBe("Claude Code");
  });

  it("resolves unseen kind ids to their category style (no null)", () => {
    const cfg = createDefaultConfig();
    // An unrecognized id maps to the system category: headerLabel null, icon Info.
    expect(headerLabelFor(cfg, "nonexistent.kind")).toBeNull();
    expect(iconNameFor(cfg, "nonexistent.kind")).toBe("Info");
  });

  it("returns the configured icon name", () => {
    const cfg = createDefaultConfig();
    expect(iconNameFor(cfg, "user.prompt")).toBe("User");
    // assistant.text has no override -> agent category icon "Bot".
    expect(iconNameFor(cfg, "assistant.text")).toBe("Bot");
    // cli-stream-result has no override -> system category icon "Info".
    expect(iconNameFor(cfg, "cli-stream-result")).toBe("Info");
  });

  it("bundles everything in presentationFor", () => {
    const cfg = createDefaultConfig();
    const p = presentationFor(cfg, "user.prompt");
    expect(p.headerLabel).toBe("You");
    expect(p.iconName).toBe("User");
    expect(p.swatch).toBeDefined();
    expect(p.style).toBeDefined();
  });

  // Regression guard. Tool-result images previously inherited
  // `user.tool-result`, whose `side-line` presentation renders no header and
  // no footer chip — so screenshots read as un-framed strays next to every
  // other message, and its `hiddenInCompact: true` buried them in compact mode.
  describe("user.tool-result.image", () => {
    it("renders as a framed card, unlike plain tool results", () => {
      const cfg = createDefaultConfig();
      expect(resolveKind(cfg, "user.tool-result.image").presentation).toBe("card");
      expect(resolveKind(cfg, "user.tool-result").presentation).toBe("side-line");
    });

    it("has a title, so it doesn't render as an anonymous block", () => {
      const cfg = createDefaultConfig();
      expect(headerLabelFor(cfg, "user.tool-result.image")).toBe("Image");
    });

    it("carries its own icon", () => {
      const cfg = createDefaultConfig();
      expect(iconNameFor(cfg, "user.tool-result.image")).toBe("Image");
    });

    it("is visible in compact mode by default, unlike plain tool results", () => {
      const cfg = createDefaultConfig();
      // A returned screenshot is usually the point of the call, not plumbing.
      expect(cfg.kinds["user.tool-result.image"]?.hiddenInCompact ?? false).toBe(false);
    });

    it("stays user-overridable like any other kind", () => {
      const cfg = createDefaultConfig();
      cfg.kinds["user.tool-result.image"] = {
        ...cfg.kinds["user.tool-result.image"],
        headerLabel: "Screenshot",
      };
      expect(headerLabelFor(cfg, "user.tool-result.image")).toBe("Screenshot");
    });
  });
});
