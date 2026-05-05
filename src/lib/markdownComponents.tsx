import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import type { CSSProperties } from "react";
import type { Components, ExtraProps } from "react-markdown";
import type { ComponentProps } from "react";
import { MarkdownBlock } from "@/components/MarkdownBlock";

type SyntaxTheme = { [key: string]: CSSProperties };
type CodeComponentProps = ComponentProps<"code"> & ExtraProps;

/**
 * Returns the `components` map for `react-markdown`'s ReactMarkdown component.
 *
 * Dispatch (driven entirely by the fenced-block language class):
 * - `language-markdown` / `language-md` → <MarkdownBlock> (Rendered/Source tabs)
 * - Any other `language-*`              → Prism <SyntaxHighlighter>
 * - No language class                   → plain <code> (covers inline code
 *                                          and fenced-but-untagged blocks)
 *
 * `react-markdown` v9 removed the `inline` prop on the `code` component;
 * dispatch is by className alone, since v9 never assigns a `language-*`
 * class to inline code.
 *
 * The shape replaces the two duplicated `code()` overrides previously
 * inlined in `StreamMessage.tsx`.
 *
 * @param syntaxTheme — the resolved Prism theme object from
 *   `getClaudeSyntaxTheme(theme)`. Passed through to SyntaxHighlighter for
 *   non-markdown fenced blocks. MarkdownBlock fetches its own theme via
 *   `useTheme()` so this argument is unused for the markdown branch.
 *
 * The return type intersects `Components` with `{ code: ... }` so callers
 * (and tests) can destructure `code` as a non-optional component without
 * a non-null assertion. The `as Components` cast at the return site
 * satisfies react-markdown's structural index-signature constraint.
 */
export function buildMarkdownComponents(
  syntaxTheme: SyntaxTheme,
): Components & { code: (props: CodeComponentProps) => JSX.Element } {
  return {
    // Conditional <pre> passthrough.
    //
    // react-markdown wraps every fenced code block in <pre><code>…</code></pre>,
    // and Tailwind Typography styles <pre> as a dark, padded, rounded card.
    // For *tagged* fences (`language-*`), our `code` override returns a
    // <MarkdownBlock> or Prism <SyntaxHighlighter> — both supply their own
    // chrome, so the prose <pre> on top produces a visible card-in-card.
    // We strip the wrapper for those.
    //
    // For *untagged* fences (just ``` … ```), the `code` override returns
    // a plain <code>. The surrounding <pre> is the *only* element preserving
    // newlines (white-space: pre); removing it collapses multiline ASCII
    // trees onto one wrapped line. Keep the default <pre> in that case so
    // prose can style it as a normal code card.
    pre({ node, children, ...props }) {
      const codeChild = (node as any)?.children?.[0];
      const className: string =
        codeChild?.properties?.className?.[0] ?? "";
      const isTagged = /^language-/.test(className);
      if (isTagged) {
        return <>{children}</>;
      }
      return <pre {...props}>{children}</pre>;
    },
    code({ node: _node, className, children, ...props }: CodeComponentProps) {
      const match = /language-(\w+)/.exec(className || "");
      const lang = match?.[1];
      const src = String(children ?? "").replace(/\n$/, "");

      if (lang === "markdown" || lang === "md") {
        return <MarkdownBlock source={src} />;
      }

      return lang ? (
        // The Claude syntax theme is transparent and the outer prose <pre>
        // (from react-markdown) is stripped for tagged fences, so this
        // wrapper supplies the visible code-panel chrome (var(--color-card),
        // matching prose's own <pre>).
        //
        // We let SyntaxHighlighter render its own <pre> (its default —
        // PreTag is omitted) so that `<code>` ends up inside a <pre>.
        // That makes the `.prose pre code` reset in styles.css fire and
        // zero out the inline-code padding which would otherwise manifest
        // as a leading first-line indent on multi-line blocks. Note:
        // `not-prose` does NOT work here — this repo's prose CSS is
        // hand-rolled and doesn't include the not-prose escape selectors.
        //
        // The inner <pre>'s chrome (background / border-radius / margin
        // from `.prose pre`) is overridden via inline customStyle, which
        // always beats external CSS — so the wrapper's chrome stays the
        // only visible card.
        <div className="rounded-md border border-border/50 bg-card overflow-hidden my-3">
          <SyntaxHighlighter
            style={syntaxTheme}
            language={lang}
            customStyle={{
              margin: 0,
              padding: "0.75rem",
              maxWidth: "100%",
              overflowX: "auto",
              background: "transparent",
              borderRadius: 0,
            }}
            {...(props as Record<string, unknown>)}
          >
            {src}
          </SyntaxHighlighter>
        </div>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  } as Components & { code: (props: CodeComponentProps) => JSX.Element };
}
