import React from "react";
import type { KindStyle, Palette } from "@/lib/messageRenderingConfig";
import { isHexColor } from "@/lib/messageRenderingConfig";
import { Card, CardContent } from "@/components/ui/card";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { accentStyleFromEntry } from "@/lib/accentStyle";
import { contentClassNames, headerClassNames, iconWrapperClassName, iconWrapperStyle, typographyFontFamily } from "@/lib/typographyClasses";
import { MessageFrameSideLine } from "@/components/StreamMessage/MessageFrameSideLine";
import { IconRenderer } from "./iconMap";
import { cn } from "@/lib/utils";

interface SamplePreviewProps {
  /** The fully-resolved style to render. */
  style: KindStyle;
  /** Kind id, when this preview is for a concrete kind (override / fixture).
   *  Used to resolve per-kind icon-chrome overrides. Categories pass none. */
  kindId?: string;
  /** Body text to render in the card. */
  text: string;
  /** Optional debug label (raw kind id) shown when the debug toggle is on. */
  debugLabel?: string;
  palette: Palette;
  /** Fixed sample timestamp shown on the card. */
  timestamp: string;
  /** When true, dims the card to show it would be collapsed in compact mode. */
  compact?: boolean;
}

/**
 * Renders a single message card using the same primitives as the live
 * StreamMessage renderer: shadcn `<Card>` + `accentStyleFromEntry` + the
 * configured header/content typography. The fixed footer timestamp and
 * optional debug kind label mirror the real `CardTimestamp` output, so the
 * editor's preview matches what the user will actually see in a session.
 *
 * Unlike the live `KindHeader` (which re-resolves the header label from the
 * live config by id), this preview renders the header straight off the
 * supplied `style` so a category or an in-progress override edit previews
 * correctly even when the id isn't persisted yet.
 */
export const SamplePreview: React.FC<SamplePreviewProps> = ({
  style,
  kindId,
  text,
  debugLabel,
  palette,
  timestamp,
  compact,
}) => {
  const { config } = useMessageRenderingConfig();
  // `style.accentColor` is either a palette name (legacy) or a hex string
  // (picker-driven). Resolve both to a PaletteEntry-shaped record.
  const entry = isHexColor(style.accentColor)
    ? ({ border: "", bg: "auto", swatch: style.accentColor } as const)
    : (palette[style.accentColor as keyof typeof palette] ?? { border: "", bg: "auto", swatch: "#888" });
  const alignClass =
    style.alignment === "right"
      ? "ml-auto max-w-[80%]"
      : style.alignment === "full"
        ? "w-full"
        : "mr-auto max-w-[80%]";

  const wouldHide = compact && style.hiddenInCompact;
  const swatch = isHexColor(style.accentColor)
    ? style.accentColor
    : (palette[style.accentColor as keyof typeof palette]?.swatch ?? "#888");

  // Side-line presentation — render the same MessageFrameSideLine the chat
  // uses, plus the alignment + opacity + timestamp/debug overlays the rest
  // of the preview expects so the editor matches the live experience.
  if (style.presentation === "side-line") {
    return (
      <div
        className={cn(
          "relative transition-opacity rounded-md px-2 py-1",
          alignClass,
          wouldHide && "opacity-40",
        )}
      >
        <MessageFrameSideLine
          iconName={style.icon}
          accentColor={style.accentColor}
          borderStyle={style.borderStyle}
        >
          {text}
        </MessageFrameSideLine>
        {wouldHide && (
          <div className="text-caption text-muted-foreground italic mt-1 ml-6">
            (hidden in compact mode)
          </div>
        )}
        <div className="flex items-center gap-2 mt-1 ml-6">
          {config.debug.showCardKindLabel && debugLabel && (
            <div
              className="px-1.5 py-0.5 rounded-md border bg-background text-[10px] text-foreground/80 font-mono pointer-events-none select-none"
              title="message type · subtype (debug overlay)"
            >
              {debugLabel}
            </div>
          )}
          <div
            className="ml-auto px-1.5 py-0.5 rounded-md border bg-background text-[10px] text-foreground/80 font-mono pointer-events-none select-none"
            title="Sample timestamp"
          >
            {timestamp}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Card
      className={cn(
        "border relative transition-opacity",
        alignClass,
        wouldHide && "opacity-40",
      )}
      style={{ ...accentStyleFromEntry(entry), borderStyle: style.borderStyle }}
    >
      <CardContent className="p-4 pb-9">
        <div className="flex items-start gap-3">
          {style.icon !== "none" && (
            <div
              className={iconWrapperClassName(config, kindId)}
              style={iconWrapperStyle(config, entry.swatch, kindId)}
            >
              <IconRenderer name={style.icon} className="h-3.5 w-3.5" />
            </div>
          )}
          <div className="flex-1 space-y-2 min-w-0">
            {style.headerLabel && (
              <div className="flex items-center gap-2">
                <span
                  className={headerClassNames(config)}
                  style={{ fontFamily: typographyFontFamily(config.typography.header), color: swatch }}
                >
                  {style.headerLabel}
                </span>
              </div>
            )}
            <div
              className={cn(contentClassNames(config), "whitespace-pre-wrap leading-relaxed text-foreground/90")}
              style={{ fontFamily: typographyFontFamily(config.typography.content) }}
            >
              {text}
            </div>
            {wouldHide && (
              <div className="text-caption text-muted-foreground italic mt-2">
                (hidden in compact mode)
              </div>
            )}
          </div>
        </div>
      </CardContent>

      {config.debug.showCardKindLabel && debugLabel && (
        <div
          className="absolute bottom-1 left-2 px-1.5 py-0.5 rounded-md border bg-background text-[10px] text-foreground/80 font-mono pointer-events-none select-none"
          title="message type · subtype (debug overlay)"
        >
          {debugLabel}
        </div>
      )}
      <div
        className="absolute bottom-1 right-2 px-1.5 py-0.5 rounded-md border bg-background text-[10px] text-foreground/80 font-mono pointer-events-none select-none"
        title="Sample timestamp"
      >
        {timestamp}
      </div>
    </Card>
  );
};
