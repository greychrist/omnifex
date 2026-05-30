import { describe, it, expect } from "vitest";
import { chipBorderValue, chipBorderPatch } from "../iconChrome";

describe("chipBorderValue", () => {
  it("maps an unset (undefined) iconBordered to 'default'", () => {
    expect(chipBorderValue(undefined)).toBe("default");
  });
  it("maps true to 'on'", () => {
    expect(chipBorderValue(true)).toBe("on");
  });
  it("maps false to 'off'", () => {
    expect(chipBorderValue(false)).toBe("off");
  });
});

describe("chipBorderPatch", () => {
  it("'default' unsets iconBordered so it falls back to the global default", () => {
    // Regression: selecting "Use default" must produce a patch that clears the
    // field via onChange — NOT rely on a mode-specific clear handler that is
    // undefined in category mode (which silently no-op'd the selection).
    expect(chipBorderPatch("default")).toEqual({ iconBordered: undefined });
  });
  it("'on' sets iconBordered true", () => {
    expect(chipBorderPatch("on")).toEqual({ iconBordered: true });
  });
  it("'off' sets iconBordered false", () => {
    expect(chipBorderPatch("off")).toEqual({ iconBordered: false });
  });
});
