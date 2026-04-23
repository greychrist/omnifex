import React from "react";
import type {
  MessageKindConfig,
  Palette,
  PaletteEntry,
} from "@/lib/messageRenderingConfig";
import { IconRenderer } from "./iconMap";
import { previewTextForKind } from "./fixtures";
import { cn } from "@/lib/utils";

export function accentStyle(entry: PaletteEntry): React.CSSProperties {
  const swatch = entry.swatch;
  return {
    borderColor: `${swatch}66`,
    backgroundColor: entry.bg === null ? "transparent" : `${swatch}1f`,
  };
}

interface SamplePreviewProps {
  kind: MessageKindConfig;
  palette: Palette;
  compact?: boolean; // if true, card renders muted to indicate it would be collapsed
}

export const SamplePreview: React.FC<SamplePreviewProps> = ({
  kind,
  palette,
  compact,
}) => {
  const entry = palette[kind.accentColor];
  const alignClass =
    kind.alignment === "right"
      ? "ml-auto max-w-[80%]"
      : kind.alignment === "full"
        ? "w-full"
        : "mr-auto max-w-[80%]";

  const wouldHide = compact && kind.hiddenInCompact;

  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 transition-opacity",
        alignClass,
        wouldHide && "opacity-40",
      )}
      style={accentStyle(entry)}
    >
      <div className="flex items-start gap-2">
        {kind.icon !== "none" && (
          <div className="mt-0.5 flex-shrink-0" style={{ color: entry.swatch }}>
            <IconRenderer name={kind.icon} className="h-4 w-4" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          {kind.headerLabel && (
            <div className="text-xs font-medium mb-1" style={{ color: entry.swatch }}>
              {kind.headerLabel}
            </div>
          )}
          <div className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
            {previewTextForKind(kind)}
          </div>
          {wouldHide && (
            <div className="text-caption text-muted-foreground italic mt-2">
              (hidden in compact mode)
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
