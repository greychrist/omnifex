import { describe, it, expect } from "vitest";
import { createDefaultConfig } from "../messageRenderingConfig";
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
});
