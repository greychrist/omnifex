import { describe, it, expect } from "vitest";
import { createDefaultConfig } from "../messageRenderingConfig";
import {
  contentClassNames,
  headerClassNames,
  typographyClassNames,
} from "../typographyClasses";

describe("typographyClasses", () => {
  it("maps the default header style to expected Tailwind classes", () => {
    const cfg = createDefaultConfig();
    expect(headerClassNames(cfg)).toBe("font-sans text-sm font-semibold");
  });

  it("maps the default content style to expected Tailwind classes", () => {
    const cfg = createDefaultConfig();
    expect(contentClassNames(cfg)).toBe("font-sans text-sm font-normal");
  });

  it("includes italic when italic is true", () => {
    const cls = typographyClassNames({
      family: "serif",
      size: "lg",
      weight: "bold",
      italic: true,
    });
    expect(cls).toBe("font-serif text-lg font-bold italic");
  });

  it("omits italic when italic is false", () => {
    const cls = typographyClassNames({
      family: "mono",
      size: "xs",
      weight: "medium",
      italic: false,
    });
    expect(cls).toBe("font-mono text-xs font-medium");
  });
});
