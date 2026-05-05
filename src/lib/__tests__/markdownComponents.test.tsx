// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// MarkdownBlock (rendered for markdown fences) calls useTheme(); mock so
// jsdom doesn't need a ThemeProvider.
vi.mock("@/hooks", () => ({
  useTheme: () => ({ theme: "gray", setTheme: () => {}, isLoading: false }),
}));

import { buildMarkdownComponents } from "../markdownComponents";

afterEach(() => cleanup());

describe("buildMarkdownComponents", () => {
  it("dispatches language-markdown to MarkdownBlock", () => {
    const components = buildMarkdownComponents({});
    const Code = components.code;
    const { container } = render(
      <Code className="language-markdown">{"# Heading"}</Code>,
    );
    expect(container.querySelector("h1")).toBeTruthy();
  });

  it("dispatches language-md to MarkdownBlock", () => {
    const components = buildMarkdownComponents({});
    const Code = components.code;
    const { container } = render(
      <Code className="language-md">{"# Heading"}</Code>,
    );
    expect(container.querySelector("h1")).toBeTruthy();
  });

  it("dispatches non-markdown languages to SyntaxHighlighter", () => {
    const components = buildMarkdownComponents({});
    const Code = components.code;
    const { container } = render(
      <Code className="language-typescript">{"const x = 1;"}</Code>,
    );
    // No <h1>, source text is in DOM.
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).toContain("const x = 1;");
  });

  it("renders code with no language as plain <code> (inline code path)", () => {
    const components = buildMarkdownComponents({});
    const Code = components.code;
    const { container } = render(<Code>{"plain text"}</Code>);
    const codeEl = container.querySelector("code");
    expect(codeEl).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain("plain text");
  });
});
