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
    code({ node: _node, className, children, ...props }: CodeComponentProps) {
      const match = /language-(\w+)/.exec(className || "");
      const lang = match?.[1];
      const src = String(children ?? "").replace(/\n$/, "");

      if (lang === "markdown" || lang === "md") {
        return <MarkdownBlock source={src} />;
      }

      return lang ? (
        <SyntaxHighlighter
          style={syntaxTheme}
          language={lang}
          PreTag="div"
          {...(props as Record<string, unknown>)}
        >
          {src}
        </SyntaxHighlighter>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  } as Components & { code: (props: CodeComponentProps) => JSX.Element };
}
