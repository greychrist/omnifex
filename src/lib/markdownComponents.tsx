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

const FENCE_COPY_CLASS = "absolute top-1 right-1 bg-card/90";

/** No padding or border, so the <pre>'s margins collapse through and the button lands on the card's own edge. */
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

/** react-markdown passes a scheme-less href untouched, and the browser would resolve it against the app's own page. */
function linkKind(href: string | undefined): LinkKind {
  if (!href || href.startsWith("#")) return "other";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") return "web";
  return scheme ? "other" : "file";
}

const logOpenFailure = (err: unknown): void => { console.error("[markdown-link]", err); };

/** Never navigate the app window. A relative file link resolves against the session's project directory. */
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
 * react-markdown v9 never gives inline code a `language-*` class, so dispatch is by className alone.
 * `streaming`: Mermaid fences show source, since a half-streamed diagram flashes a parse error per chunk.
 */
export function buildMarkdownComponents(
  syntaxTheme: SyntaxTheme,
  options: { streaming?: boolean } = {},
): Components & { code: (props: CodeComponentProps) => React.JSX.Element } {
  return {
    a: MarkdownLink,
    // Tagged fences bring their own chrome, so their <pre> would be card-in-card. Untagged keep it: it alone preserves newlines.
    pre({ node, children, ...props }) {
      const codeChild = node?.children[0];
      const classNames = codeChild?.type === "element" ? codeChild.properties.className : undefined;
      const first: unknown = Array.isArray(classNames) ? classNames[0] : undefined;
      const className = typeof first === "string" ? first : "";
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
        // SyntaxHighlighter renders its own <pre> so the `.prose pre code` reset applies; this repo's prose CSS has no not-prose escape.
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
