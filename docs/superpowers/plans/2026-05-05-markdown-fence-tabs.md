# MarkdownBlock — Source/Rendered tabs implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Claude returns a fenced ```` ```markdown ```` (or `` ```md ``) block in a response, render it as a small card with a Rendered/Source pill toggle and a copy-source button — Rendered by default — instead of always showing the markdown source under Prism syntax highlighting.

**Architecture:** New `<MarkdownBlock>` component owns the toggle and the copy button. A new `buildMarkdownComponents(syntaxTheme)` helper returns the `code` component map used by ReactMarkdown — it dispatches `language-markdown` / `language-md` to `<MarkdownBlock>` and everything else to `react-syntax-highlighter` Prism. Both ReactMarkdown call sites in `StreamMessage.tsx` switch from inline duplicated `code()` overrides to this shared helper. `MarkdownBlock`'s rendered view uses the same helper, so a `` ```markdown `` fence inside a `` ```markdown `` fence recurses naturally.

**Tech Stack:** React 19, TypeScript, Tailwind v4, `react-markdown`, `remark-gfm`, `react-syntax-highlighter` (Prism), Vitest + `@testing-library/react` + jsdom for tests.

**Spec:** `docs/superpowers/specs/2026-05-05-markdown-fence-tabs-design.md`.

---

## File structure

| Status | Path | Responsibility |
|---|---|---|
| New | `src/components/MarkdownBlock.tsx` | Tabbed presentation of one markdown fence: Rendered/Source pill toggle, Copy-source button, owns `view` state |
| New | `src/components/__tests__/MarkdownBlock.test.tsx` | Unit tests for `MarkdownBlock` (render default, toggle, copy, aria, empty source) |
| New | `src/lib/markdownComponents.tsx` | `buildMarkdownComponents(syntaxTheme)` — returns the `code` override map for `react-markdown`. Dispatches `markdown`/`md` to `<MarkdownBlock>`, others to `<SyntaxHighlighter>` |
| New | `src/lib/__tests__/markdownComponents.test.tsx` | Unit tests for the dispatcher (markdown → MarkdownBlock, ts → SyntaxHighlighter, inline → `<code>`) |
| Edit | `src/components/StreamMessage.tsx` | Remove the two duplicated inline `code()` overrides at lines 583-601 and 1400-1417, replace both with `components={mdComponents}` where `mdComponents = buildMarkdownComponents(syntaxTheme)` |

---

## Task 1: `MarkdownBlock` component (TDD, no recursion yet)

**Files:**
- Create: `src/components/__tests__/MarkdownBlock.test.tsx`
- Create: `src/components/MarkdownBlock.tsx`

This task implements `MarkdownBlock` using *vanilla* `ReactMarkdown` (no custom components map). Recursion (a `` ```markdown `` inside a `` ```markdown ``) is added in Task 3 once `buildMarkdownComponents` exists.

- [ ] **Step 1.1: Write the failing tests**

Create `src/components/__tests__/MarkdownBlock.test.tsx`:

```tsx
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

afterEach(() => cleanup());

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

  it("copy button writes the raw source to clipboard regardless of view", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const SRC = "# Hello\n\n**bold** and `code`";
    render(<MarkdownBlock source={SRC} />);

    fireEvent.click(screen.getByRole("button", { name: /copy source/i }));
    expect(writeText).toHaveBeenLastCalledWith(SRC);

    fireEvent.click(screen.getByRole("button", { name: /^source$/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy source/i }));
    expect(writeText).toHaveBeenLastCalledWith(SRC);
  });

  it("renders empty source without throwing and keeps both pills", () => {
    expect(() => render(<MarkdownBlock source="" />)).not.toThrow();
    expect(screen.getByRole("button", { name: /^rendered$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^source$/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^source$/i }));
    expect(screen.getByRole("button", { name: /^rendered$/i })).toBeTruthy();
  });
});
```

- [ ] **Step 1.2: Run the tests to confirm they fail**

```bash
npm test -- src/components/__tests__/MarkdownBlock.test.tsx
```

Expected: FAIL — `Cannot find module '../MarkdownBlock'` (the implementation file does not exist yet).

- [ ] **Step 1.3: Implement `MarkdownBlock` (no recursion)**

Create `src/components/MarkdownBlock.tsx`:

```tsx
import React, { useState } from "react";
import { Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { useTheme } from "@/hooks";
import { getClaudeSyntaxTheme } from "@/lib/claudeSyntaxTheme";
import { cn } from "@/lib/utils";

type View = "rendered" | "source";

interface MarkdownBlockProps {
  /** Raw markdown source — what was inside the ```markdown fence. */
  source: string;
}

/**
 * Renders one fenced markdown block with a Rendered/Source pill toggle
 * and a copy-source button. Default view is Rendered. The copy button
 * always copies the raw source string regardless of which view is active.
 *
 * Recursion (a ```markdown fence nested inside another ```markdown fence)
 * is added in a follow-up step that wires `buildMarkdownComponents` into
 * the inner ReactMarkdown call. Until then, the inner ReactMarkdown uses
 * vanilla defaults.
 */
export const MarkdownBlock: React.FC<MarkdownBlockProps> = ({ source }) => {
  const [view, setView] = useState<View>("rendered");
  const [copied, setCopied] = useState(false);
  const { theme } = useTheme();
  const syntaxTheme = getClaudeSyntaxTheme(theme);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      console.error("MarkdownBlock copy failed:", err);
    }
  };

  const pillBase =
    "text-[10px] px-2 py-0.5 font-medium transition-colors";
  const pillActive = "bg-foreground/10 text-foreground";
  const pillInactive = "text-muted-foreground hover:text-foreground";

  return (
    <div className="relative group/mdblock my-3 rounded-md border border-border/50 bg-muted/20 overflow-hidden">
      <div className="absolute top-1 right-1 z-10 flex items-center gap-1 opacity-60 group-hover/mdblock:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy source"
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          title={copied ? "Copied!" : "Copy source"}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
        <div
          role="group"
          aria-label="View mode"
          className="flex items-center rounded-md border border-border/50 bg-background/80 backdrop-blur-sm overflow-hidden"
        >
          <button
            type="button"
            onClick={() => setView("rendered")}
            aria-pressed={view === "rendered"}
            className={cn(pillBase, view === "rendered" ? pillActive : pillInactive)}
          >
            Rendered
          </button>
          <button
            type="button"
            onClick={() => setView("source")}
            aria-pressed={view === "source"}
            className={cn(pillBase, view === "source" ? pillActive : pillInactive)}
          >
            Source
          </button>
        </div>
      </div>

      {view === "rendered" ? (
        <div className="prose prose-sm dark:prose-invert max-w-none p-3 break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
        </div>
      ) : (
        <SyntaxHighlighter
          style={syntaxTheme}
          language="markdown"
          PreTag="div"
          customStyle={{
            margin: 0,
            padding: "0.75rem",
            maxWidth: "100%",
            overflowX: "auto",
          }}
        >
          {source}
        </SyntaxHighlighter>
      )}
    </div>
  );
};
```

- [ ] **Step 1.4: Run the tests to confirm they pass**

```bash
npm test -- src/components/__tests__/MarkdownBlock.test.tsx
```

Expected: PASS — all 6 tests green.

- [ ] **Step 1.5: Commit**

```bash
git add src/components/MarkdownBlock.tsx src/components/__tests__/MarkdownBlock.test.tsx
git commit -m "feat(MarkdownBlock): add Rendered/Source tabbed component for fenced markdown"
```

---

## Task 2: `buildMarkdownComponents` dispatcher (TDD)

**Files:**
- Create: `src/lib/__tests__/markdownComponents.test.tsx`
- Create: `src/lib/markdownComponents.tsx`

The helper returns the `components` map ReactMarkdown consumes. It dispatches `language-markdown` / `language-md` fenced blocks to `<MarkdownBlock>` and everything else to `<SyntaxHighlighter>`. Inline code passes through unchanged.

- [ ] **Step 2.1: Write the failing tests**

Create `src/lib/__tests__/markdownComponents.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";

// Same useTheme mock as MarkdownBlock — the dispatcher renders
// MarkdownBlock for markdown fences, which calls useTheme.
vi.mock("@/hooks", () => ({
  useTheme: () => ({ theme: "gray", setTheme: () => {}, isLoading: false }),
}));

import { buildMarkdownComponents } from "../markdownComponents";

afterEach(() => cleanup());

describe("buildMarkdownComponents", () => {
  it("dispatches language-markdown to MarkdownBlock (Rendered view by default → <h1>)", () => {
    const components = buildMarkdownComponents({});
    const Code = components.code as React.FC<any>;
    const { container } = render(
      <Code className="language-markdown" inline={false}>
        {"# Heading"}
      </Code>,
    );
    expect(container.querySelector("h1")).toBeTruthy();
  });

  it("dispatches language-md to MarkdownBlock", () => {
    const components = buildMarkdownComponents({});
    const Code = components.code as React.FC<any>;
    const { container } = render(
      <Code className="language-md" inline={false}>
        {"# Heading"}
      </Code>,
    );
    expect(container.querySelector("h1")).toBeTruthy();
  });

  it("dispatches non-markdown languages to SyntaxHighlighter (no <h1>, source visible)", () => {
    const components = buildMarkdownComponents({});
    const Code = components.code as React.FC<any>;
    const { container } = render(
      <Code className="language-typescript" inline={false}>
        {"const x = 1;"}
      </Code>,
    );
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).toContain("const x = 1;");
  });

  it("renders inline code as a plain <code> element", () => {
    const components = buildMarkdownComponents({});
    const Code = components.code as React.FC<any>;
    const { container } = render(
      <Code className="language-typescript" inline>
        {"x"}
      </Code>,
    );
    const codeEl = container.querySelector("code");
    expect(codeEl).toBeTruthy();
    // Inline path renders a single <code> with the literal text — no <pre>.
    expect(container.querySelector("pre")).toBeNull();
    expect(codeEl?.textContent).toBe("x");
  });

  it("renders a fence with no language as plain <code>", () => {
    const components = buildMarkdownComponents({});
    const Code = components.code as React.FC<any>;
    const { container } = render(
      <Code inline={false}>{"plain text"}</Code>,
    );
    expect(container.querySelector("code")).toBeTruthy();
    expect(container.textContent).toContain("plain text");
  });
});
```

- [ ] **Step 2.2: Run the tests to confirm they fail**

```bash
npm test -- src/lib/__tests__/markdownComponents.test.tsx
```

Expected: FAIL — `Cannot find module '../markdownComponents'`.

- [ ] **Step 2.3: Implement `buildMarkdownComponents`**

Create `src/lib/markdownComponents.tsx`:

```tsx
import React from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { MarkdownBlock } from "@/components/MarkdownBlock";

/**
 * Returns the `components` map for `react-markdown`'s ReactMarkdown component.
 *
 * Dispatch:
 * - Fenced ```markdown / ```md → <MarkdownBlock> (Rendered/Source tabs)
 * - Other fenced languages      → Prism <SyntaxHighlighter>
 * - Inline code or no-language  → plain <code>
 *
 * The shape mirrors the inline `code()` override that previously lived
 * (duplicated) inside `StreamMessage.tsx` at lines 583-601 and 1400-1417.
 *
 * @param syntaxTheme — the resolved Prism theme object from
 *   `getClaudeSyntaxTheme(theme)`. Passed through to SyntaxHighlighter for
 *   non-markdown fenced blocks. MarkdownBlock fetches its own theme via
 *   `useTheme()` so this argument is unused for the markdown branch.
 */
export function buildMarkdownComponents(syntaxTheme: any) {
  return {
    code({ node, inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || "");
      const lang = match?.[1];
      const src = String(children).replace(/\n$/, "");

      if (!inline && (lang === "markdown" || lang === "md")) {
        return <MarkdownBlock source={src} />;
      }

      return !inline && lang ? (
        <SyntaxHighlighter
          style={syntaxTheme}
          language={lang}
          PreTag="div"
          {...props}
        >
          {src}
        </SyntaxHighlighter>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };
}
```

- [ ] **Step 2.4: Run the tests to confirm they pass**

```bash
npm test -- src/lib/__tests__/markdownComponents.test.tsx
```

Expected: PASS — all 5 tests green.

- [ ] **Step 2.5: Commit**

```bash
git add src/lib/markdownComponents.tsx src/lib/__tests__/markdownComponents.test.tsx
git commit -m "feat(markdownComponents): add ReactMarkdown code dispatcher"
```

---

## Task 3: Wire `MarkdownBlock` recursion through `buildMarkdownComponents`

**Files:**
- Modify: `src/components/MarkdownBlock.tsx`

`MarkdownBlock`'s rendered view currently uses vanilla `ReactMarkdown`. Pass it the same dispatcher so a `` ```markdown `` fence inside a `` ```markdown `` fence renders as another `<MarkdownBlock>`.

- [ ] **Step 3.1: Update `MarkdownBlock.tsx` to use `buildMarkdownComponents`**

In `src/components/MarkdownBlock.tsx`, add this import near the other `@/lib` imports:

```tsx
import { buildMarkdownComponents } from "@/lib/markdownComponents";
```

Replace the rendered-branch JSX (currently calling vanilla `<ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>`) with one that passes `components={mdComponents}`. Compute `mdComponents` once per render right before the `return`:

```tsx
  const mdComponents = buildMarkdownComponents(syntaxTheme);

  return (
    <div className="relative group/mdblock my-3 rounded-md border border-border/50 bg-muted/20 overflow-hidden">
      {/* …pill toggle and copy button unchanged… */}

      {view === "rendered" ? (
        <div className="prose prose-sm dark:prose-invert max-w-none p-3 break-words">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={mdComponents}
          >
            {source}
          </ReactMarkdown>
        </div>
      ) : (
        <SyntaxHighlighter
          style={syntaxTheme}
          language="markdown"
          PreTag="div"
          customStyle={{
            margin: 0,
            padding: "0.75rem",
            maxWidth: "100%",
            overflowX: "auto",
          }}
        >
          {source}
        </SyntaxHighlighter>
      )}
    </div>
  );
```

(The rest of the component — pill toggle, copy button, state, useTheme — is untouched.)

- [ ] **Step 3.2: Run all tests to confirm nothing regressed**

```bash
npm test -- src/components/__tests__/MarkdownBlock.test.tsx src/lib/__tests__/markdownComponents.test.tsx
```

Expected: PASS — all 11 tests green. Existing `MarkdownBlock` tests still pass because none of them assert on lack-of-recursion; the rendered-view DOM is unchanged for non-nested input.

- [ ] **Step 3.3: TypeScript check**

```bash
npm run check
```

Expected: PASS — TypeScript clean.

- [ ] **Step 3.4: Commit**

```bash
git add src/components/MarkdownBlock.tsx
git commit -m "feat(MarkdownBlock): recurse via buildMarkdownComponents in Rendered view"
```

---

## Task 4: Refactor `StreamMessage.tsx` to use `buildMarkdownComponents`

**Files:**
- Modify: `src/components/StreamMessage.tsx` (two ReactMarkdown call sites; lines as of HEAD when this plan was written: 583-601 and 1400-1417)

Replace the duplicated inline `code()` overrides at both ReactMarkdown call sites with a single shared `mdComponents = buildMarkdownComponents(syntaxTheme)`. Net effect: identical behaviour today for every non-markdown fenced block, plus tabbed rendering for `` ```markdown `` / `` ```md `` blocks.

- [ ] **Step 4.1: Add the import**

In `src/components/StreamMessage.tsx`, add this import alongside the existing `@/lib` imports:

```tsx
import { buildMarkdownComponents } from "@/lib/markdownComponents";
```

- [ ] **Step 4.2: Compute `mdComponents` once at the top of the component**

`StreamMessage` already computes `syntaxTheme` near the top of its render (around line 369-370):

```tsx
  const { theme } = useTheme();
  const syntaxTheme = getClaudeSyntaxTheme(theme);
```

Add the next line directly after it:

```tsx
  const mdComponents = buildMarkdownComponents(syntaxTheme);
```

- [ ] **Step 4.3: Replace the first inline `code()` override (assistant text path)**

Find the first `<ReactMarkdown>` call (around line 581), currently:

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={{
    code({ node, inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      return !inline && match ? (
        <SyntaxHighlighter
          style={syntaxTheme}
          language={match[1]}
          PreTag="div"
          {...props}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
  }}
>
  {textContent}
</ReactMarkdown>
```

Replace with:

```tsx
<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
  {textContent}
</ReactMarkdown>
```

- [ ] **Step 4.4: Replace the second inline `code()` override (result path)**

Find the second `<ReactMarkdown>` call (around line 1398), currently identical to the first but with `{message.result}` as the body. Replace its `components={{ … }}` prop with `components={mdComponents}`:

```tsx
<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
  {message.result}
</ReactMarkdown>
```

- [ ] **Step 4.5: TypeScript + build check**

```bash
npm run check
```

Expected: PASS.

```bash
npm run build
```

Expected: Vite build clean.

- [ ] **Step 4.6: Run the full test suite**

```bash
npm test
```

Expected: PASS — 1202+ tests, 1 skipped, no regressions.

- [ ] **Step 4.7: Commit**

```bash
git add src/components/StreamMessage.tsx
git commit -m "refactor(StreamMessage): use buildMarkdownComponents helper for ReactMarkdown code override"
```

---

## Task 5: Verification gate + Electron rebuild

**Files:** none (verification only)

- [ ] **Step 5.1: Full TypeScript check**

```bash
npm run check
```

Expected: PASS — `tsc --noEmit && tsc --noEmit -p tsconfig.electron.json` clean.

- [ ] **Step 5.2: Vite build**

```bash
npm run build
```

Expected: Built artifacts in `dist/`, no warnings about new chunks beyond expected size deltas.

- [ ] **Step 5.3: Test suite (one-shot)**

```bash
npm test
```

Expected: All test files pass. The new tests add ~11 cases to the existing 1202.

- [ ] **Step 5.4: Restore Electron ABI for native modules**

Vitest runs use the Node ABI (`pretest` rebuilds `better-sqlite3` + `node-pty` for Node). After tests, native modules must be rebuilt for Electron or the app will crash on launch.

```bash
npm run rebuild:electron
```

Expected: `verified: native modules at NMV 145 (Electron ABI)`.

- [ ] **Step 5.5: Visual sanity check (manual)**

Restart the app (`npm start`) and open the WIN session `f68cfc22-a065-4ee3-b6b5-61fb316d5eeb` (final assistant message). Expected:

- The `` ```markdown `` block renders as a formatted document by default (headings, bold, lists rendered).
- Top-right of the block: a small pill pair `[ Rendered | Source ]` (Rendered active) and a copy icon to its left.
- Hovering the block brightens the controls from 60 % to 100 % opacity.
- Clicking `Source` swaps to the Prism syntax-highlighted view of the markdown source. Clicking `Rendered` swaps back.
- Clicking the copy icon copies the raw markdown source to the clipboard regardless of which view is active.
- No card pushes wider than `w-[95%]`. Long inline code inside the rendered view wraps; long lines inside the Source view scroll horizontally inside the block.

If anything looks off, do not commit further; bring the symptom back to the design discussion.

---

## Self-review notes (informational, not actionable)

Spec coverage check (run during plan authoring):

- Spec § Component → Task 1 (component) + Task 3 (recursion wiring).
- Spec § Wiring into StreamMessage → Task 4.
- Spec § Refactor: shared `mdComponents` map → Task 2 (helper) + Task 4 (consumer wiring).
- Spec § Edge cases → Task 1 tests cover empty source, default view, toggle round-trip, copy behaviour, aria. Recursion is covered by Task 3 wiring; nested rendering is not separately unit-tested because the component is identical at each depth and the dispatcher is independently tested.
- Spec § Testing → Tasks 1 + 2 cover the named tests. The "no new tests for `StreamMessage.tsx`" decision is honoured in Task 4.
- Spec § Verification gate → Task 5.
- Spec § Out of scope items (user-prompt cards, mdx, persistence, non-markdown preview) → not addressed by any task, by design.
