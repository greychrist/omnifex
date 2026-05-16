// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// MarkdownBlock (rendered for markdown fences) calls useTheme(); mock so
// jsdom doesn't need a ThemeProvider.
vi.mock("@/hooks", () => ({
  useTheme: () => ({ theme: "gray", setTheme: () => {}, isLoading: false }),
}));

import { buildMarkdownComponents } from "../markdownComponents";

afterEach(() => { cleanup(); });

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

  it("wraps tagged fences in card chrome (gray background, border)", () => {
    // The Claude syntax theme uses a transparent background, and the
    // outer prose <pre> is stripped for tagged fences (to avoid the
    // concentric-card on markdown blocks). Without this wrapper, a
    // ```typescript fence would render naked against the surrounding
    // assistant message tint. Match the panel color prose's own <pre>
    // uses (var(--color-card)) so tagged, untagged, and markdown
    // fences all read as the same code panel.
    const components = buildMarkdownComponents({});
    const Code = components.code;
    const { container } = render(
      <Code className="language-typescript">{"const x = 1;"}</Code>,
    );
    const wrapper = container.querySelector('[class*="bg-card"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper?.className ?? "").toMatch(/\bborder\b/);
    expect(wrapper?.className ?? "").toMatch(/\brounded-md\b/);
  });

  it("renders tagged fences with a <pre> ancestor on <code> (lets .prose pre code reset fire)", () => {
    // SyntaxHighlighter must render <code> inside a <pre> so that the
    // `.prose pre code { padding: 0; ... }` reset in styles.css fires.
    // Without it, `.prose code` adds horizontal inline padding which
    // manifests as a leading first-line indent on multi-line blocks.
    // (`not-prose` does NOT help here — this codebase's prose CSS is
    // hand-rolled and doesn't include the not-prose escape selectors.)
    const components = buildMarkdownComponents({});
    const Code = components.code;
    const { container } = render(
      <Code className="language-typescript">{"const x = 1;\nconst y = 2;"}</Code>,
    );
    const wrapper = container.querySelector('[class*="bg-card"]');
    expect(wrapper).toBeTruthy();
    const code = wrapper?.querySelector("code");
    expect(code).toBeTruthy();
    // <code> must have a <pre> ancestor inside the wrapper.
    expect(code?.closest("pre")).toBeTruthy();
  });

  it("does not wrap a markdown fence in a <pre> (no concentric card)", () => {
    // react-markdown wraps fenced code blocks in <pre><code>...</code></pre>
    // by default. Tailwind Typography (`prose`) styles <pre> as a dark
    // padded rounded card — when the inner <code> is replaced by a
    // <MarkdownBlock> (which has its own card chrome), the result is a
    // visible card-in-card. The components map must override <pre> to
    // be a passthrough so MarkdownBlock owns the only card.
    const components = buildMarkdownComponents({});
    const md = "```markdown\n# Heading\n```\n";
    const { container } = render(
      <ReactMarkdown components={components}>{md}</ReactMarkdown>,
    );
    // MarkdownBlock rendered (rendered view shows the heading).
    expect(container.querySelector("h1")).toBeTruthy();
    // No <pre> wrapping it.
    expect(container.querySelector("pre")).toBeNull();
  });

  it("preserves <pre> for untagged fenced code (whitespace not collapsed)", () => {
    // Regression: an earlier version made the `pre` override an
    // unconditional fragment, which removed the only element that
    // preserves newlines for untagged ``` fences. Result: multiline
    // ASCII trees collapsed onto one wrapped line with `|` separators.
    // Untagged fences must still emit a real <pre>.
    const components = buildMarkdownComponents({});
    const md = "```\nline-one\nline-two\nline-three\n```\n";
    const { container } = render(
      <ReactMarkdown components={components}>{md}</ReactMarkdown>,
    );
    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    const code = pre?.querySelector("code");
    expect(code).toBeTruthy();
    // Newlines preserved in the rendered text.
    expect(code?.textContent ?? "").toContain("line-one\nline-two\nline-three");
  });

  it("re-render with the same components prop preserves the inner code DOM node", () => {
    // Regression: StreamMessage used to rebuild `mdComponents` on every
    // render. ReactMarkdown saw a new `components` prop, re-rendered its
    // tree, and the inner SyntaxHighlighter created fresh DOM nodes —
    // wiping any active text selection inside the inner code card.
    // With a stable `components` prop, React's reconciler must keep the
    // <code> DOM node identical across re-renders.
    const components = buildMarkdownComponents({});
    const remarkPlugins = [remarkGfm];
    const md = "```typescript\nconst x = 1;\n```\n";
    const { container, rerender } = render(
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {md}
      </ReactMarkdown>,
    );
    const codeBefore = container.querySelector("code");
    expect(codeBefore).toBeTruthy();
    rerender(
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {md}
      </ReactMarkdown>,
    );
    const codeAfter = container.querySelector("code");
    expect(codeAfter).toBe(codeBefore);
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
