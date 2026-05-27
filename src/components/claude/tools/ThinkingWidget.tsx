import React, { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
import { headerLabelFor, iconNameFor } from "@/lib/kindPresentation";
import { IconRenderer } from "@/components/settings-panels/appearance/iconMap";

/**
 * Widget for displaying AI thinking/reasoning content
 * Collapsible and closed by default
 */
export const ThinkingWidget: React.FC<{
  thinking: string;
  signature?: string;
  /** When true, the widget starts expanded. Used when rendered inside an
   *  already-expanded compact group — the user asked to see the contents,
   *  so hiding the thought behind a second click feels broken. */
  defaultExpanded?: boolean;
}> = ({ thinking, defaultExpanded = false }) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const { config } = useMessageRenderingConfig();

  const style = accentStyleFor(config, "assistant.thinking");
  const swatch = swatchFor(config, "assistant.thinking");
  const iconName = iconNameFor(config, "assistant.thinking");
  const headerLabel = headerLabelFor(config, "assistant.thinking") ?? "Thinking...";
  const swatchStyle: React.CSSProperties | undefined = swatch ? { color: swatch } : undefined;

  const trimmedThinking = thinking.trim();

  return (
    <div className="rounded-lg border overflow-hidden" style={style}>
      <button
        onClick={() => { setIsExpanded(!isExpanded); }}
        className="w-full px-4 py-3 flex items-center justify-between transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="relative" style={swatchStyle}>
            {iconName && iconName !== "none" ? (
              <IconRenderer name={iconName} className="h-4 w-4" />
            ) : (
              <Sparkles className="h-4 w-4 animate-pulse" />
            )}
          </div>
          <span className="text-sm font-semibold italic" style={swatchStyle}>
            {headerLabel}
          </span>
        </div>
        <ChevronRight
          className={cn("h-4 w-4 transition-transform", isExpanded && "rotate-90")}
          style={swatchStyle}
        />
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 pt-2 border-t" style={style}>
          <pre
            className="text-xs font-mono whitespace-pre-wrap p-3 rounded-lg italic"
            style={{ ...style, ...swatchStyle }}
          >
            {trimmedThinking}
          </pre>
        </div>
      )}
    </div>
  );
};
