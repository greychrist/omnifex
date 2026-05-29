import React, { useState } from "react";
import { ChevronRight, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
import { iconNameFor } from "@/lib/kindPresentation";
import { IconRenderer } from "@/components/settings-panels/appearance/iconMap";

interface MessageFrameCollapsibleProps {
  /** Drives icon, accent, and the configured header label. Must match an
   *  entry in DEFAULT_KINDS. */
  kindId: string;
  /** Overrides the kind's configured `headerLabel`. Used for content-derived
   *  titles (e.g. "Skill: Brainstorming Ideas Into Designs"). */
  headerLabel?: string | null;
  /** Toolbar node rendered absolutely top-right (e.g. a `CardActionBar`
   *  copy button). The container is `group/card relative` so the bar can
   *  position itself the same way it does inside `MessageFrameCard`. */
  actionBar?: React.ReactNode;
  /** Body — revealed only when expanded. Caller owns its styling (e.g. a
   *  monospace `<pre>` for system-context). */
  children: React.ReactNode;
}

/**
 * Collapsible card shell — a third presentation variant alongside
 * `MessageFrameCard` and `MessageFrameSideLine`. Renders an always-visible
 * header row (icon + label + chevron, plus any forwarded `actionBar`) and an
 * expandable body, collapsed by default. Honors the same config knobs as the
 * other frames (accent color via `accentStyleFor`, icon via `iconNameFor`),
 * so per-kind color/icon edits in Appearance apply here too.
 */
export const MessageFrameCollapsible: React.FC<MessageFrameCollapsibleProps> = ({
  kindId,
  headerLabel,
  actionBar,
  children,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { config } = useMessageRenderingConfig();

  const style = accentStyleFor(config, kindId);
  const swatch = swatchFor(config, kindId);
  const swatchStyle = swatch ? { color: swatch } : undefined;
  const iconName = iconNameFor(config, kindId);
  const label = headerLabel ?? config.kinds[kindId]?.headerLabel ?? "Context";

  return (
    <div className="relative group/card rounded-lg border overflow-hidden" style={style}>
      {actionBar}
      <button
        type="button"
        onClick={() => { setIsExpanded((v) => !v); }}
        className="w-full px-4 py-2 flex items-center justify-between transition-colors"
      >
        <div className="flex items-center gap-2">
          <div style={swatchStyle}>
            {iconName && iconName !== "none" ? (
              <IconRenderer name={iconName} className="h-4 w-4" />
            ) : (
              <Info className="h-4 w-4" />
            )}
          </div>
          <span className="text-xs font-medium" style={swatchStyle}>
            {label}
          </span>
        </div>
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-90")}
          style={swatchStyle}
        />
      </button>

      {isExpanded && (
        <div className="px-4 pb-3 pt-1 border-t" style={style}>
          {children}
        </div>
      )}
    </div>
  );
};
