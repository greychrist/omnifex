import React from "react";
import { ALL_KIND_RECORDS } from "@/lib/sampleTranscript";
import { modernCssVars, type MessageRenderingConfig, type ViewMode } from "@/lib/messageRenderingConfig";
import { transcriptItems } from "@/lib/transcriptItems";
import { modernTurnFooters } from "@/lib/modernTurnFooter";
import { MessageRenderingPreviewProvider } from "@/contexts/MessageRenderingContext";
import { ModernTranscriptItem, type ModernRowContext } from "@/components/transcript-modern/ModernTranscriptItem";
import { cn } from "@/lib/utils";

const PREVIEW_CTX: ModernRowContext = { tabId: "settings-turn-preview" };
const VIEWS: { value: ViewMode; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "expanded", label: "Expanded" },
];

/**
 * Settings › Chats › Turn preview: the sample transcript — a record of every
 * message kind — drawn by the real Modern renderer against the draft config,
 * in either view, so a kind's icon, color or Show in Standard can be seen
 * changing.
 */
export const ModernTurnPreview: React.FC<{ config: MessageRenderingConfig }> = ({ config }) => {
  const [view, setView] = React.useState<ViewMode>("standard");
  const items = React.useMemo(() => transcriptItems(ALL_KIND_RECORDS, config, view), [config, view]);
  const footers = React.useMemo(() => modernTurnFooters(items, ALL_KIND_RECORDS, false), [items]);
  const vars = Object.fromEntries(
    Object.entries(modernCssVars(config.modern)).filter(([, v]) => v !== null),
  ) as React.CSSProperties;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-heading-4">Turn preview</h3>
          <p className="text-caption text-muted-foreground mt-1">
            A session with a record of every kind, as a session draws it. Standard leaves out what Messages hides; Expanded shows every record.
          </p>
        </div>
        <div role="radiogroup" aria-label="Preview view" className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="radio"
              aria-checked={view === v.value}
              onClick={() => { setView(v.value); }}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                view === v.value ? "bg-background shadow-sm" : "hover:bg-background/50",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <MessageRenderingPreviewProvider config={config}>
        <div
          role="region"
          aria-label="Turn preview"
          className="modern-format space-y-4 rounded-md border border-border bg-background p-4"
          style={vars}
        >
          {items.map((item) => (
            <ModernTranscriptItem key={item.key} item={item} live={false} ctx={PREVIEW_CTX} footer={footers.get(item.key)} />
          ))}
        </div>
      </MessageRenderingPreviewProvider>
    </div>
  );
};
