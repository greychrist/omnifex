import { describe, it, expect } from "vitest";
import { resolveIndicatorColor, TAB_INDICATOR_PX } from "../tabIndicatorStyle";

// Indicator colours are hex since the palette was retired; a saved palette
// name is converted on config load, so the resolver only guards junk.
describe("resolveIndicatorColor", () => {
  it("passes hex colors through unchanged", () => {
    expect(resolveIndicatorColor("#ff0000")).toBe("#ff0000");
  });

  it("falls back to neutral grey for anything that is not a hex", () => {
    expect(resolveIndicatorColor("green")).toBe("#4b5563");
    expect(resolveIndicatorColor("not-a-color")).toBe("#4b5563");
  });
});

describe("TAB_INDICATOR_PX", () => {
  it("maps the size scale to pixels", () => {
    expect(TAB_INDICATOR_PX).toEqual({ sm: 14, md: 16, lg: 18 });
  });
});
