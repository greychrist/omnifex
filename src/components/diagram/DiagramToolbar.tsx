import React, { useState } from "react";
import { Download, ImageIcon, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fireAndLog } from "@/lib/fireAndLog";
import { CopyButton } from "@/components/ui/copy-button";
import {
  canCopyImage,
  copyPng,
  diagramFileName,
  downloadBlob,
  svgForExport,
  svgToPng,
} from "@/lib/diagramExport";

interface DiagramToolbarProps {
  source: string;
  /** A light-theme render of `source` — what every export is made from. */
  getLightSvg: () => Promise<string>;
  /** Omitted inside the full-window viewer, which is already expanded. */
  onExpand?: () => void;
  className?: string;
}

/**
 * A bordered segmented bar, the same chrome as the Diagram/Source toggle
 * (MermaidBlock) and MarkdownBlock's Rendered/Source pills, so the block's
 * controls read as one row of like controls. The overlay's zoom group uses
 * the same two constants.
 */
export const BAR =
  "flex items-center rounded-md border border-border/50 bg-background/80 overflow-hidden divide-x divide-border/50";
export const BAR_BUTTON =
  "inline-flex items-center gap-1 rounded-none px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors disabled:opacity-50 [&_svg]:h-3 [&_svg]:w-3";

/** Expand, download (SVG / PNG) and copy (image / source) for one diagram. */
export const DiagramToolbar: React.FC<DiagramToolbarProps> = ({
  source,
  getLightSvg,
  onExpand,
  className,
}) => {
  const [busy, setBusy] = useState(false);

  const run = (label: string, action: () => Promise<void>) =>
    fireAndLog(label, async () => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    });

  const downloadSvg = run("diagram:download-svg", async () => {
    const file = svgForExport(await getLightSvg());
    downloadBlob(new Blob([file], { type: "image/svg+xml" }), diagramFileName("svg"));
  });

  const downloadPng = run("diagram:download-png", async () => {
    downloadBlob(await svgToPng(await getLightSvg()), diagramFileName("png"));
  });

  const copyImage = run("diagram:copy-image", async () => {
    await copyPng(await svgToPng(await getLightSvg()));
  });

  return (
    <div role="group" aria-label="Diagram actions" className={cn(BAR, className)}>
      <button type="button" className={BAR_BUTTON} onClick={downloadSvg} disabled={busy} aria-label="Download SVG" title="Download SVG">
        <Download />
        <span>SVG</span>
      </button>
      <button type="button" className={BAR_BUTTON} onClick={downloadPng} disabled={busy} aria-label="Download PNG" title="Download PNG">
        <Download />
        <span>PNG</span>
      </button>
      {canCopyImage() && (
        <button type="button" className={BAR_BUTTON} onClick={copyImage} disabled={busy} aria-label="Copy image" title="Copy image">
          <ImageIcon />
          <span>Image</span>
        </button>
      )}
      <CopyButton getText={() => source} label="Copy source" text="Copy" className={BAR_BUTTON} />
      {onExpand && (
        <button type="button" className={BAR_BUTTON} onClick={onExpand} aria-label="Expand diagram" title="Expand">
          <Maximize2 />
          <span>Expand</span>
        </button>
      )}
    </div>
  );
};
