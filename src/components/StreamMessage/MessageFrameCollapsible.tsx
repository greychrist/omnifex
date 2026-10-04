import React, { useState } from "react";
import { ChevronsUpDown, Info } from "lucide-react";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
import { iconNameFor } from "@/lib/kindPresentation";
import { resolveKind } from "@/lib/messageRenderingConfig";
import { IconRenderer } from "@/components/settings-panels/appearance/iconMap";
import { CardActionBarPlacementContext } from "@/components/CardActionBar";

interface MessageFrameCollapsibleProps {
  /** Drives icon, accent, and the configured header label. Must match an
   *  entry in DEFAULT_KINDS. */
  kindId: string;
  /** Overrides the kind's configured `headerLabel`. Used for content-derived
   *  titles (e.g. "Skill: Brainstorming Ideas Into Designs"). */
  headerLabel?: string | null;
  /** Toolbar node (e.g. a `CardActionBar`) seated at the end of the header
   *  row, beside the toggle rather than inside it, so its buttons do not
   *  expand the card. Inline, as in `MessageFrameCard`'s header, so the row's
   *  flex centring places it — an overlay pinned top-right sat low in a
   *  one-line header and covered the chevron. The up/down chevron closes the
   *  row, where the hidden-events card puts its own. */
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
  const toggle = () => { setIsExpanded((v) => !v); };
  const { config } = useMessageRenderingConfig();

  const style = accentStyleFor(config, kindId);
  const swatch = swatchFor(config, kindId);
  const swatchStyle = swatch ? { color: swatch } : undefined;
  const iconName = iconNameFor(config, kindId);
  const label = headerLabel ?? resolveKind(config, kindId).headerLabel ?? "Context";

  return (
    <div className="group/card rounded-lg border overflow-hidden" style={style}>
      <div className="flex items-center gap-2 pr-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isExpanded}
          className="min-w-0 flex-1 px-4 py-2 flex items-center gap-2 text-left"
        >
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
        </button>
        {actionBar && (
          <CardActionBarPlacementContext.Provider value="inline">
            {actionBar}
          </CardActionBarPlacementContext.Provider>
        )}
        {/* A second hit target for the same toggle, out of the tab order:
            the label button above is the accessible one. */}
        <button
          type="button"
          onClick={toggle}
          tabIndex={-1}
          aria-hidden="true"
          data-collapsible-chevron=""
          className="shrink-0 py-2 text-muted-foreground/70"
        >
          <ChevronsUpDown className="h-3.5 w-3.5" style={swatchStyle} />
        </button>
      </div>

      {isExpanded && (
        <div className="px-4 pb-3 pt-1 border-t" style={style}>
          {children}
        </div>
      )}
    </div>
  );
};
