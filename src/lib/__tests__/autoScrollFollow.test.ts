import { describe, it, expect } from "vitest";
import {
  DEFAULT_AUTOSCROLL_FOLLOW_PX,
  parseFollowPx,
  isFollowing,
} from "../autoScrollFollow";

describe("parseFollowPx", () => {
  it("returns the parsed integer for a valid stored string", () => {
    expect(parseFollowPx("250")).toBe(250);
  });

  it("falls back to the default when nothing is stored", () => {
    expect(parseFollowPx(null)).toBe(DEFAULT_AUTOSCROLL_FOLLOW_PX);
  });

  it("falls back when the value is not a number", () => {
    expect(parseFollowPx("abc")).toBe(DEFAULT_AUTOSCROLL_FOLLOW_PX);
  });

  it("falls back when the value is negative", () => {
    expect(parseFollowPx("-50")).toBe(DEFAULT_AUTOSCROLL_FOLLOW_PX);
  });

  it("floors fractional strings", () => {
    expect(parseFollowPx("250.9")).toBe(250);
  });
});

describe("isFollowing", () => {
  it("follows within the distance", () => {
    expect(isFollowing(100, 200)).toBe(true);
  });

  it("follows at exactly the distance", () => {
    expect(isFollowing(200, 200)).toBe(true);
  });

  it("stops beyond the distance", () => {
    expect(isFollowing(201, 200)).toBe(false);
  });

  it("follows only at the very bottom when the distance is 0", () => {
    expect(isFollowing(0, 0)).toBe(true);
    expect(isFollowing(1, 0)).toBe(false);
  });
});
