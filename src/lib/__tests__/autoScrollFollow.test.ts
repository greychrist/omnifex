import { describe, it, expect } from "vitest";
import {
  DEFAULT_AUTOSCROLL_FOLLOW_PX,
  parseFollowPx,
  isFollowing,
  nextFollowing,
} from "../autoScrollFollow";

describe("parseFollowPx", () => {
  it("returns the parsed integer for a valid stored string", () => {
    expect(parseFollowPx("250")).toBe(250);
  });

  it("falls back to the default when nothing is stored", () => {
    expect(parseFollowPx(null)).toBe(DEFAULT_AUTOSCROLL_FOLLOW_PX);
  });

  it("defaults to 300px", () => {
    expect(DEFAULT_AUTOSCROLL_FOLLOW_PX).toBe(300);
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

/**
 * Only the user can turn following off. A scroll event the user did not cause
 * — layout settling, the live bubble swapping for the final message, our own
 * scroll-to-bottom measured a frame late — must never leave the tail.
 */
describe("nextFollowing", () => {
  it("follows whenever the view is within followPx, whoever scrolled", () => {
    expect(nextFollowing({ following: false, distanceFromBottom: 100, followPx: 300, userScrolling: false })).toBe(true);
    expect(nextFollowing({ following: false, distanceFromBottom: 300, followPx: 300, userScrolling: true })).toBe(true);
  });

  it("stops following when the user scrolls past followPx", () => {
    expect(nextFollowing({ following: true, distanceFromBottom: 301, followPx: 300, userScrolling: true })).toBe(false);
  });

  it("keeps following when content, not the user, moved the view away", () => {
    expect(nextFollowing({ following: true, distanceFromBottom: 900, followPx: 300, userScrolling: false })).toBe(true);
  });

  it("stays off when already off and still outside followPx", () => {
    expect(nextFollowing({ following: false, distanceFromBottom: 900, followPx: 300, userScrolling: false })).toBe(false);
  });
});
