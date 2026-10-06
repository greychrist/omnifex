import { describe, it, expect } from "vitest";
import {
  DEFAULT_AUTOSCROLL_REENGAGE_PX,
  parseThresholdPx,
  clampThresholds,
  nextNearBottom,
} from "../autoScrollThresholds";

describe("parseThresholdPx", () => {
  it("returns the parsed integer for a valid stored string", () => {
    expect(parseThresholdPx("250", DEFAULT_AUTOSCROLL_REENGAGE_PX)).toBe(250);
  });

  it("falls back when the value is null", () => {
    expect(parseThresholdPx(null, 400)).toBe(400);
  });

  it("falls back when the value is not a number", () => {
    expect(parseThresholdPx("abc", 800)).toBe(800);
  });

  it("falls back when the value is negative", () => {
    expect(parseThresholdPx("-50", 400)).toBe(400);
  });

  it("floors fractional strings", () => {
    expect(parseThresholdPx("250.9", 400)).toBe(250);
  });
});

describe("clampThresholds", () => {
  it("keeps a valid pair unchanged", () => {
    expect(clampThresholds({ reengagePx: 400, disengagePx: 800 })).toEqual({
      reengagePx: 400,
      disengagePx: 800,
    });
  });

  it("raises disengage to at least reengage so the hysteresis gap never inverts", () => {
    expect(clampThresholds({ reengagePx: 600, disengagePx: 300 })).toEqual({
      reengagePx: 600,
      disengagePx: 600,
    });
  });

  it("clamps negatives to zero", () => {
    expect(clampThresholds({ reengagePx: -10, disengagePx: -5 })).toEqual({
      reengagePx: 0,
      disengagePx: 0,
    });
  });

  it("floors fractional inputs", () => {
    expect(clampThresholds({ reengagePx: 400.7, disengagePx: 800.2 })).toEqual({
      reengagePx: 400,
      disengagePx: 800,
    });
  });
});

describe("nextNearBottom", () => {
  const t = { reengagePx: 400, disengagePx: 800 };

  it("re-engages when within the re-engage distance", () => {
    expect(nextNearBottom(100, false, t)).toBe(true);
  });

  it("disengages when beyond the disengage distance", () => {
    expect(nextNearBottom(900, true, t)).toBe(false);
  });

  it("holds the current state inside the dead zone (was engaged)", () => {
    expect(nextNearBottom(600, true, t)).toBe(true);
  });

  it("holds the current state inside the dead zone (was disengaged)", () => {
    expect(nextNearBottom(600, false, t)).toBe(false);
  });

  it("treats the re-engage boundary as not-yet re-engaged (strict <)", () => {
    expect(nextNearBottom(400, false, t)).toBe(false);
  });

  it("treats the disengage boundary as not-yet disengaged (strict >)", () => {
    expect(nextNearBottom(800, true, t)).toBe(true);
  });
});
