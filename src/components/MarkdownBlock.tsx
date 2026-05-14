import React, { useState, useRef, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { useTheme } from "@/hooks";
import { getClaudeSyntaxTheme } from "@/lib/claudeSyntaxTheme";
import { buildMarkdownComponents } from "@/lib/markdownComponents";
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
 * is supported: the inner `ReactMarkdown` is wired with the shared
 * `buildMarkdownComponents` dispatcher, so any nested markdown fence
 * renders as another `<MarkdownBlock>` with its own toggle and copy
 * button. Each component instance owns its own `view` state, so inner
 * and outer toggles operate independently.
 */
export const MarkdownBlock: React.FC<MarkdownBlockProps> = ({ source }) => {
  const [view, setView] = useState<View>("rendered");
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { theme } = useTheme();
  const syntaxTheme = getClaudeSyntaxTheme(theme);
  const mdComponents = buildMarkdownComponents(syntaxTheme);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1200);
    } catch (err) {
      console.error("MarkdownBlock copy failed:", err);
    }
  };

  const pillBase =
    "text-[10px] px-2 py-0.5 font-medium transition-colors";
  const pillActive = "bg-foreground/10 text-foreground";
  const pillInactive = "text-muted-foreground hover:text-foreground";

  return (
    <div className="my-3">
      <div className="flex items-center justify-end gap-2 mb-2">
        <div
          role="group"
          aria-label="View mode"
          className="flex items-center rounded-md border border-border/50 bg-background/80 overflow-hidden"
        >
          <button
            type="button"
            onClick={() => { setView("rendered"); }}
            aria-pressed={view === "rendered"}
            className={cn(pillBase, view === "rendered" ? pillActive : pillInactive)}
          >
            Rendered
          </button>
          <button
            type="button"
            onClick={() => { setView("source"); }}
            aria-pressed={view === "source"}
            className={cn(pillBase, view === "source" ? pillActive : pillInactive)}
          >
            Source
          </button>
        </div>
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
      </div>

      <div className="rounded-md border border-border/50 bg-card overflow-hidden">
        {view === "rendered" ? (
          <div className="prose prose-sm dark:prose-invert max-w-none break-words p-3">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {source}
            </ReactMarkdown>
          </div>
        ) : (
          <SyntaxHighlighter
            style={syntaxTheme}
            language="markdown"
            customStyle={{
              margin: 0,
              padding: "0.75rem",
              maxWidth: "100%",
              overflowX: "auto",
              background: "transparent",
              borderRadius: 0,
            }}
          >
            {source}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
};
