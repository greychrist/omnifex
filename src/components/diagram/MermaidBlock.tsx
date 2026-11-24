import React, { useCallback, useEffect, useState } from "react";
import { useTheme } from "@/hooks";
import { cn } from "@/lib/utils";
import { renderMermaid } from "@/lib/mermaid/loadMermaid";
import { CopyButton } from "@/components/ui/copy-button";
import { BAR, BAR_BUTTON, DiagramToolbar } from "./DiagramToolbar";
import { DiagramOverlay } from "./DiagramOverlay";

interface MermaidBlockProps {
  source: string;
  /** Show the source until complete: a half-written diagram doesn't parse. */
  streaming?: boolean;
}

type Drawing =
  | { state: "loading" }
  | { state: "ready"; svg: string }
  | { state: "error"; message: string };

type View = "diagram" | "source";

const PILL = "text-[10px] px-2 py-0.5 font-medium transition-colors";
const PILL_ON = "bg-foreground/10 text-foreground";
const PILL_OFF = "text-muted-foreground hover:text-foreground";

// Inline styles: only they beat the hand-rolled `.prose pre` / `.prose code` CSS.
const PRE_RESET: React.CSSProperties = { margin: 0, background: "transparent", border: 0, borderRadius: 0 };
const CODE_RESET: React.CSSProperties = { background: "transparent", padding: 0, border: 0 };

function SourceView({ source }: { source: string }): React.JSX.Element {
  return (
    <pre className="p-3 text-xs overflow-x-auto whitespace-pre" style={PRE_RESET}>
      <code style={CODE_RESET}>{source}</code>
    </pre>
  );
}

export const MermaidBlock: React.FC<MermaidBlockProps> = ({ source, streaming = false }) => {
  const { theme } = useTheme();
  // Results are keyed by what they were drawn from, so a change reads as loading without a setState in the effect.
  const drawKey = `${theme}\u0000${source}`;
  const [result, setResult] = useState<{ key: string; drawing: Drawing } | null>(null);
  const drawing: Drawing = result?.key === drawKey ? result.drawing : { state: "loading" };
  const [view, setView] = useState<View>("diagram");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (streaming) return;
    let current = true;
    renderMermaid(source, theme).then(
      (svg) => { if (current) setResult({ key: drawKey, drawing: { state: "ready", svg } }); },
      (err: unknown) => {
        if (!current) return;
        const message = err instanceof Error ? err.message : String(err);
        setResult({ key: drawKey, drawing: { state: "error", message } });
      },
    );
    return () => { current = false; };
  }, [source, theme, streaming, drawKey]);

  const readySvg = drawing.state === "ready" ? drawing.svg : null;
  const getLightSvg = useCallback(
    () => (theme === "light" && readySvg !== null ? Promise.resolve(readySvg) : renderMermaid(source, "light")),
    [theme, readySvg, source],
  );

  if (streaming) {
    return (
      <div className="my-3 rounded-md border border-border/50 bg-card overflow-hidden">
        <div className="px-3 pt-2 text-[10px] text-muted-foreground">Diagram — draws when the reply finishes</div>
        <SourceView source={source} />
      </div>
    );
  }

  const ready = drawing.state === "ready";

  return (
    <div className="my-3">
      <div className="flex items-center justify-end gap-2 mb-2">
        {ready && (
          <div role="group" aria-label="View mode" className="flex items-center rounded-md border border-border/50 bg-background/80 overflow-hidden">
            <button type="button" onClick={() => { setView("diagram"); }} aria-pressed={view === "diagram"} className={cn(PILL, view === "diagram" ? PILL_ON : PILL_OFF)}>
              Diagram
            </button>
            <button type="button" onClick={() => { setView("source"); }} aria-pressed={view === "source"} className={cn(PILL, view === "source" ? PILL_ON : PILL_OFF)}>
              Source
            </button>
          </div>
        )}
        {ready ? (
          <DiagramToolbar source={source} getLightSvg={getLightSvg} onExpand={() => { setExpanded(true); }} />
        ) : (
          <div role="group" aria-label="Diagram actions" className={BAR}>
            <CopyButton getText={() => source} label="Copy source" text="Copy" className={BAR_BUTTON} />
          </div>
        )}
      </div>

      <div className="rounded-md border border-border/50 bg-card overflow-hidden">
        {drawing.state === "loading" && (
          <div className="p-3 text-xs text-muted-foreground">Drawing diagram…</div>
        )}
        {drawing.state === "error" && (
          <>
            <div className="px-3 pt-2 text-xs text-destructive">Diagram could not be drawn: {drawing.message}</div>
            <SourceView source={source} />
          </>
        )}
        {ready && view === "diagram" && (
          <div
            className="omnifex-diagram p-3 flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
            // Mermaid's own output under securityLevel 'strict' (DOMPurify'd).
            dangerouslySetInnerHTML={{ __html: drawing.svg }}
          />
        )}
        {ready && view === "source" && <SourceView source={source} />}
      </div>

      {expanded && ready && (
        <DiagramOverlay
          svg={drawing.svg}
          source={source}
          getLightSvg={getLightSvg}
          onClose={() => { setExpanded(false); }}
        />
      )}
    </div>
  );
};
