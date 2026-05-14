// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// Mock useTheme — MarkdownBlock pulls the syntax theme via useTheme(),
// which would otherwise throw without a ThemeProvider. Returning the
// 'gray' theme matches the production default.
vi.mock("@/hooks", () => ({
  useTheme: () => ({ theme: "gray", setTheme: () => {}, isLoading: false }),
}));

import { MarkdownBlock } from "../MarkdownBlock";

afterEach(() => { cleanup(); });

describe("MarkdownBlock", () => {
  it("defaults to Rendered view (markdown is parsed to HTML)", () => {
    render(<MarkdownBlock source={"# Hello\n\nWorld"} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Hello" }),
    ).toBeTruthy();
  });

  it("switches to Source view when the Source pill is clicked", () => {
    render(<MarkdownBlock source={"# Hello"} />);
    fireEvent.click(screen.getByRole("button", { name: /^source$/i }));
    // Heading is gone — Rendered view is no longer mounted.
    expect(
      screen.queryByRole("heading", { level: 1, name: "Hello" }),
    ).toBeNull();
    // The literal source is in the DOM (inside a Prism block).
    expect(document.body.textContent).toContain("# Hello");
  });

  it("switches back to Rendered after toggling Source then Rendered", () => {
    render(<MarkdownBlock source={"# Hello"} />);
    fireEvent.click(screen.getByRole("button", { name: /^source$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^rendered$/i }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Hello" }),
    ).toBeTruthy();
  });

  it("aria-pressed reflects the active pill", () => {
    render(<MarkdownBlock source={"# Hello"} />);
    const rendered = screen.getByRole("button", { name: /^rendered$/i });
    const source = screen.getByRole("button", { name: /^source$/i });
    expect(rendered.getAttribute("aria-pressed")).toBe("true");
    expect(source.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(source);
    expect(rendered.getAttribute("aria-pressed")).toBe("false");
    expect(source.getAttribute("aria-pressed")).toBe("true");
  });

  describe("clipboard interactions", () => {
    let writeText: ReturnType<typeof vi.fn>;
    let originalDescriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      originalDescriptor = Object.getOwnPropertyDescriptor(
        navigator,
        "clipboard",
      );
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
    });

    afterEach(() => {
      if (originalDescriptor) {
        Object.defineProperty(navigator, "clipboard", originalDescriptor);
      } else {
        // No original descriptor — delete the mock so subsequent tests
        // see the unmocked navigator.clipboard (or undefined in jsdom).
        delete (navigator as any).clipboard;
      }
    });

    it("copy button writes the raw source to clipboard regardless of view", () => {
      const SRC = "# Hello\n\n**bold** and `code`";
      render(<MarkdownBlock source={SRC} />);

      fireEvent.click(screen.getByRole("button", { name: /copy source/i }));
      expect(writeText).toHaveBeenLastCalledWith(SRC);

      fireEvent.click(screen.getByRole("button", { name: /^source$/i }));
      fireEvent.click(screen.getByRole("button", { name: /copy source/i }));
      expect(writeText).toHaveBeenLastCalledWith(SRC);
    });
  });

  it("renders empty source without throwing and keeps both pills", () => {
    expect(() => render(<MarkdownBlock source="" />)).not.toThrow();
    expect(screen.getByRole("button", { name: /^rendered$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^source$/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^source$/i }));
    expect(screen.getByRole("button", { name: /^rendered$/i })).toBeTruthy();
  });
});
