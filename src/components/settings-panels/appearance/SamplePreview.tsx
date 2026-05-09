import React from "react";
import type {
  MessageKindConfig,
  Palette,
} from "@/lib/messageRenderingConfig";
import { Card, CardContent } from "@/components/ui/card";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { accentStyleFromEntry } from "@/lib/accentStyle";
import { contentClassNames, iconSizeClassName, iconWrapperClassName, iconWrapperStyle, typographyFontFamily } from "@/lib/typographyClasses";
import { KindHeader } from "@/components/KindHeader";
import { IconRenderer } from "./iconMap";
import { previewTextForKind, debugLabelForKind, SAMPLE_TIMESTAMP } from "./fixtures";
import { cn } from "@/lib/utils";

interface SamplePreviewProps {
  kind: MessageKindConfig;
  palette: Palette;
  /** When true, dims the card to show it would be collapsed in compact mode. */
  compact?: boolean;
}

/**
 * Renders a single message card using the same primitives as the live
 * StreamMessage renderer: shadcn `<Card>` + `accentStyleFromEntry` + the
 * shared `<KindHeader>` + the configured content typography. The fixed
 * footer timestamp and optional debug kind label mirror the real
 * `CardTimestamp` output, so the editor's preview matches what the user
 * will actually see in a session.
 */
export const SamplePreview: React.FC<SamplePreviewProps> = ({
  kind,
  palette,
  compact,
}) => {
  const { config } = useMessageRenderingConfig();
  const entry = palette[kind.accentColor];
  const alignClass =
    kind.alignment === "right"
      ? "ml-auto max-w-[80%]"
      : kind.alignment === "full"
        ? "w-full"
        : "mr-auto max-w-[80%]";

  const wouldHide = compact && kind.hiddenInCompact;

  return (
    <Card
      className={cn(
        "border relative transition-opacity",
        alignClass,
        wouldHide && "opacity-40",
      )}
      style={accentStyleFromEntry(entry)}
    >
      <CardContent className="p-4 pb-9">
        <div className="flex items-start gap-3">
          {kind.icon !== "none" && (
            <div
              className={iconWrapperClassName(config, kind.id)}
              style={iconWrapperStyle(config, entry.swatch, kind.id)}
            >
              <IconRenderer name={kind.icon} className={iconSizeClassName(config, kind.id)} />
            </div>
          )}
          <div className="flex-1 space-y-2 min-w-0">
            <KindHeader kindId={kind.id} fallbackLabel={kind.headerLabel} />
            <div
              className={cn(contentClassNames(config), "whitespace-pre-wrap leading-relaxed text-foreground/90")}
              style={{ fontFamily: typographyFontFamily(config.typography.content) }}
            >
              {previewTextForKind(kind)}
            </div>
            {wouldHide && (
              <div className="text-caption text-muted-foreground italic mt-2">
                (hidden in compact mode)
              </div>
            )}
          </div>
        </div>
      </CardContent>

      {config.debug.showCardKindLabel && (
        <div
          className="absolute bottom-1 left-2 px-1.5 py-0.5 rounded-md border bg-background text-[10px] text-foreground/80 font-mono pointer-events-none select-none"
          title="SDK message type · subtype (debug overlay)"
        >
          {debugLabelForKind(kind)}
        </div>
      )}
      <div
        className="absolute bottom-1 right-2 px-1.5 py-0.5 rounded-md border bg-background text-[10px] text-foreground/80 font-mono pointer-events-none select-none"
        title="Sample timestamp"
      >
        {SAMPLE_TIMESTAMP}
      </div>
    </Card>
  );
};
