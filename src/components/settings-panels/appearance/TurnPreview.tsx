import React from "react";
import { Layers } from "lucide-react";
import type { MessageRenderingConfig } from "@/lib/messageRenderingConfig";
import { SamplePreview } from "./SamplePreview";
import { FAKE_TURN_KIND_IDS } from "./fixtures";
import { cn } from "@/lib/utils";

interface TurnPreviewProps {
  config: MessageRenderingConfig;
  mode: "compact" | "verbose";
}

// In compact mode, consecutive hidden kinds collapse into a single "group
// marker" row. This mirrors the CollapsibleGroup behavior in the live
// renderer (compactGrouping.ts), simplified for the preview.

interface CompactItem {
  kind: "single" | "group";
  ids: string[]; // for group, list of hidden kinds rolled up
}

function groupTurn(
  kindIds: string[],
  config: MessageRenderingConfig,
): CompactItem[] {
  const items: CompactItem[] = [];
  let buffer: string[] = [];
  const flushGroup = () => {
    if (buffer.length > 0) {
      items.push({ kind: "group", ids: buffer });
      buffer = [];
    }
  };
  for (const id of kindIds) {
    const k = config.kinds[id];
    if (!k) continue;
    if (k.hiddenInCompact && !k.compactBoundaryLocked) {
      buffer.push(id);
    } else {
      flushGroup();
      items.push({ kind: "single", ids: [id] });
    }
  }
  flushGroup();
  return items;
}

export const TurnPreview: React.FC<TurnPreviewProps> = ({ config, mode }) => {
  if (mode === "verbose") {
    return (
      <div className="space-y-2">
        {FAKE_TURN_KIND_IDS.map((id, i) => {
          const k = config.kinds[id];
          if (!k) return null;
          return <SamplePreview key={`${id}-${i}`} kind={k} palette={config.palette} />;
        })}
      </div>
    );
  }

  const items = groupTurn(FAKE_TURN_KIND_IDS, config);
  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        if (item.kind === "single") {
          const k = config.kinds[item.ids[0]];
          return <SamplePreview key={`s-${i}`} kind={k} palette={config.palette} />;
        }
        return <CollapsedGroupMarker key={`g-${i}`} count={item.ids.length} />;
      })}
    </div>
  );
};

const CollapsedGroupMarker: React.FC<{ count: number }> = ({ count }) => (
  <div
    className={cn(
      "flex items-center gap-2 rounded-md border border-dashed border-border/60 px-3 py-2",
      "text-xs text-muted-foreground bg-muted/20 italic",
    )}
  >
    <Layers className="h-3.5 w-3.5" />
    {count} interior {count === 1 ? "step" : "steps"} collapsed
  </div>
);
