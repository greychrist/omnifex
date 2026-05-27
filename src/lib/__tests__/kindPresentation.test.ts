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

  it("returns null when the kind's headerLabel is null", () => {
    const cfg = createDefaultConfig();
    // v2 catalog: assistant.tool-use has headerLabel: null (no header shown).
    expect(headerLabelFor(cfg, "assistant.tool-use")).toBeNull();
  });

  it("returns a user override for headerLabel", () => {
    const cfg = createDefaultConfig();
    cfg.kinds["assistant.text"].headerLabel = "Claude Code";
    expect(headerLabelFor(cfg, "assistant.text")).toBe("Claude Code");
  });

  it("returns null for unknown kind ids", () => {
    const cfg = createDefaultConfig();
    expect(headerLabelFor(cfg, "nonexistent.kind")).toBeNull();
    expect(iconNameFor(cfg, "nonexistent.kind")).toBeNull();
  });

  it("returns the configured icon name", () => {
    const cfg = createDefaultConfig();
    expect(iconNameFor(cfg, "user.prompt")).toBe("User");
    expect(iconNameFor(cfg, "assistant.text")).toBe("Bot");
    // v2 catalog: cli-stream-result uses "Check".
    expect(iconNameFor(cfg, "cli-stream-result")).toBe("Check");
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
