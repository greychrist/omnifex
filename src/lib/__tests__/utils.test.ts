import { describe, it, expect } from "vitest";
import { cn } from "../utils";

describe("cn", () => {
  it("joins simple class strings", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("filters out falsy values", () => {
    expect(cn("a", false && "b", undefined, null, "c")).toBe("a c");
  });

  it("merges conflicting tailwind classes (last wins)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("respects object-form conditional classes", () => {
    expect(cn({ "text-white": true, "text-black": false })).toBe("text-white");
  });

  it("flattens nested arrays", () => {
    expect(cn(["a", ["b", "c"]])).toBe("a b c");
  });
});
