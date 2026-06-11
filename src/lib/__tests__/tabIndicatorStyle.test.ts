import { describe, it, expect } from "vitest";
import { resolveIndicatorColor, TAB_INDICATOR_PX } from "../tabIndicatorStyle";
import { DEFAULT_PALETTE } from "../messageRenderingConfig";

describe("resolveIndicatorColor", () => {
  it("passes hex colors through unchanged", () => {
    expect(resolveIndicatorColor("#ff0000", DEFAULT_PALETTE)).toBe("#ff0000");
  });

  it("resolves a palette name to its swatch", () => {
    expect(resolveIndicatorColor("green", DEFAULT_PALETTE)).toBe(
      DEFAULT_PALETTE.green.swatch,
    );
    expect(resolveIndicatorColor("yellow", DEFAULT_PALETTE)).toBe(
      DEFAULT_PALETTE.yellow.swatch,
    );
  });

  it("falls back to the muted swatch for an unknown name", () => {
    expect(resolveIndicatorColor("not-a-color", DEFAULT_PALETTE)).toBe(
      DEFAULT_PALETTE.muted.swatch,
    );
  });
});

describe("TAB_INDICATOR_PX", () => {
  it("maps the size scale to pixels", () => {
    expect(TAB_INDICATOR_PX).toEqual({ sm: 14, md: 16, lg: 18 });
  });
});
