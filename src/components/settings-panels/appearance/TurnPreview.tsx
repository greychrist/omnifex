import React from "react";
import { Layers } from "lucide-react";
import type { MessageRenderingConfig, MessageKindsById } from "@/lib/messageRenderingConfig";
import { deriveKinds } from "@/lib/messageRenderingConfig";
import { SamplePreview } from "./SamplePreview";
import { FAKE_TURN_KIND_IDS } from "./fixtures";
import { cn } from "@/lib/utils";

interface TurnPreviewProps {
  config: MessageRenderingConfig;
  mode: "compact" | "verbose";
}

// In compact mode, consecutive hidden kinds collapse into a single
// "Hidden Events" expander row. This mirrors HiddenEventsGroup in the
// live renderer (compactGrouping.ts), simplified for the preview.

interface CompactItem {
  kind: "single" | "group";
  ids: string[]; // for group, list of hidden kinds rolled up
}

function groupTurn(
  kindIds: string[],
  kinds: MessageKindsById,
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
    const k = kinds[id];
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
  const kinds = deriveKinds(config);
  if (mode === "verbose") {
    return (
      <div className="space-y-2">
        {FAKE_TURN_KIND_IDS.map((id, i) => {
          const k = kinds[id];
          if (!k) return null;
          return <SamplePreview key={`${id}-${i}`} kind={k} palette={config.palette} />;
        })}
      </div>
    );
  }

  const items = groupTurn(FAKE_TURN_KIND_IDS, kinds);
  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        if (item.kind === "single") {
          const k = kinds[item.ids[0]];
          if (!k) return null;
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
      "flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-1.5",
      "text-xs text-muted-foreground",
    )}
  >
    <Layers className="h-3.5 w-3.5" />
    <span className="font-medium text-foreground/80">
      {count} Hidden {count === 1 ? "Event" : "Events"}:
    </span>
    <span className="truncate">collapsed in compact mode</span>
  </div>
);
