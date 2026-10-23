import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { useRef } from "react";
import type * as React from "react";
import type { CSSProperties } from "react";
import type { Components, ExtraProps } from "react-markdown";
import type { ComponentProps } from "react";
import { MarkdownBlock } from "@/components/MarkdownBlock";
import { MermaidBlock } from "@/components/diagram/MermaidBlock";
import { CopyButton } from "@/components/ui/copy-button";
import { FileText } from "lucide-react";
import { platform } from "@/lib/platform";
import { useSessionActions } from "@/contexts/SessionActionsContext";

type SyntaxTheme = Record<string, CSSProperties>;
type CodeComponentProps = ComponentProps<"code"> & ExtraProps;

// Pinned over the code card's top-right corner rather than given a header
// row, so a fence is no taller with it than without. The solid backing is
// what keeps a long first line from showing through the icon.
const FENCE_COPY_CLASS = "absolute top-1 right-1 bg-card/90";

/**
 * An untagged fence: prose's own <pre> card, plus a copy button. The text is
 * read off the rendered <pre> at click time — the children are React nodes,
 * and what is on screen is exactly what was inside the fence.
 *
 * The wrapper has no padding or border, so the <pre>'s prose margins collapse
 * through it and the wrapper's top edge IS the card's top edge — which is
 * where the absolutely positioned button lands.
 */
function UntaggedFence(props: ComponentProps<"pre">): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null);
  return (
    <div className="relative">
      <pre ref={preRef} {...props} />
      <CopyButton
        label="Copy code"
        getText={() => preRef.current?.textContent?.replace(/\n$/, "") ?? ""}
        className={FENCE_COPY_CLASS}
      />
    </div>
  );
}

type LinkKind = "web" | "file" | "other";

/**
 * A scheme-less href is a file path: react-markdown passes `/Users/…` and
 * `reports/x.md` through untouched, and the browser would resolve either
 * against the app's own page. Other schemes (mailto:, …) and in-page anchors
 * keep default behaviour, which main's navigation policy contains.
 */
function linkKind(href: string | undefined): LinkKind {
  if (!href || href.startsWith("#")) return "other";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") return "web";
  return scheme ? "other" : "file";
}

const logOpenFailure = (err: unknown): void => { console.error("[markdown-link]", err); };

/**
 * Web links open in the browser and file links in their default app — never
 * in the app window, which a bare `/Users/…` link replaced (2026-10-22). A
 * relative file link resolves against the session's project directory.
 */
function MarkdownLink({ node: _node, href, children, ...props }: ComponentProps<"a"> & ExtraProps): React.JSX.Element {
  const session = useSessionActions();
  const kind = linkKind(href);
  if (kind === "other" || !href) return <a href={href} {...props}>{children}</a>;
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const opened = kind === "web" ? platform.openExternal(href) : platform.openPath(href, session?.projectPath);
    opened.catch(logOpenFailure);
  };
  return (
    <a href={href} {...props} onClick={onClick} title={kind === "file" ? `Open ${href}` : props.title}>
      {kind === "file" && (
        <FileText data-file-link-icon aria-hidden className="inline h-3.5 w-3.5 mr-0.5 -mt-0.5 align-middle" />
      )}
      {children}
    </a>
  );
}

/**
 * Returns the `components` map for `react-markdown`'s ReactMarkdown component.
 *
 * Dispatch (driven entirely by the fenced-block language class):
 * - `language-markdown` / `language-md` → <MarkdownBlock> (Rendered/Source tabs)
 * - `language-mermaid`                  → <MermaidBlock> (drawn diagram)
 * - Any other `language-*`              → Prism <SyntaxHighlighter>
 * - No language class                   → plain <code> (covers inline code
 *                                          and fenced-but-untagged blocks)
 *
 * Every fenced block gets a copy button: untagged ones on the <pre> (see
 * `UntaggedFence`), tagged ones on their card, markdown ones in
 * MarkdownBlock's own toolbar. Inline code never reaches either path.
 *
 * Links go through `MarkdownLink`: web links to the browser, file paths to
 * their default app.
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
 * @param options.streaming — the message is still arriving (the in-flight
 *   bubble). Mermaid fences then show their source: a half-streamed diagram
 *   does not parse and would flash an error on every chunk.
 *
 * The return type intersects `Components` with `{ code: ... }` so callers
 * (and tests) can destructure `code` as a non-optional component without
 * a non-null assertion. The `as Components` cast at the return site
 * satisfies react-markdown's structural index-signature constraint.
 */
export function buildMarkdownComponents(
  syntaxTheme: SyntaxTheme,
  options: { streaming?: boolean } = {},
): Components & { code: (props: CodeComponentProps) => React.JSX.Element } {
  return {
    a: MarkdownLink,
    // Conditional <pre> passthrough.
    //
    // react-markdown wraps every fenced code block in <pre><code>…</code></pre>,
    // and Tailwind Typography styles <pre> as a dark, padded, rounded card.
    // For *tagged* fences (`language-*`), our `code` override returns a
    // <MarkdownBlock>, <MermaidBlock> or Prism <SyntaxHighlighter> — each supplies its own
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
      const isTagged = className.startsWith("language-");
      if (isTagged) {
        return <>{children}</>;
      }
      return <UntaggedFence {...props}>{children}</UntaggedFence>;
    },
    code({ node: _node, className, children, ...props }: CodeComponentProps) {
      const match = /language-(\w+)/.exec(className || "");
      const lang = match?.[1];
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- caller controls input; falls back to JSON.stringify upstream.
      const src = String(children ?? "").replace(/\n$/, "");

      if (lang === "markdown" || lang === "md") {
        return <MarkdownBlock source={src} />;
      }

      if (lang === "mermaid") {
        return <MermaidBlock source={src} streaming={options.streaming} />;
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
        <div className="relative rounded-md border border-border/50 bg-card overflow-hidden my-3">
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
          <CopyButton label="Copy code" getText={() => src} className={FENCE_COPY_CLASS} />
        </div>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };
}
