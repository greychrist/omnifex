import React from "react";
import { cn } from "@/lib/utils";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { headerLabelFor, iconNameFor } from "@/lib/kindPresentation";
import { swatchFor } from "@/lib/accentStyle";
import { headerClassNames, typographyFontFamily } from "@/lib/typographyClasses";
import { IconRenderer } from "@/components/settings-panels/appearance/iconMap";
import type { IconName } from "@/lib/messageRenderingConfig";

interface KindHeaderProps {
  kindId: string;
  /** Overrides the configured headerLabel. Use for sub-result variants like
   *  "Edit Result" / "Read Result" that share a kind's palette but carry a
   *  specific fixed label. */
  label?: string | null;
  /** Used when the kind's headerLabel is null — pass null to suppress the row entirely. */
  fallbackLabel?: string | null;
  fallbackIcon?: IconName;
  /** When true, render the inline icon to the left of the label. */
  showIcon?: boolean;
  className?: string;
}

/**
 * Single source of truth for rendering the small header row (icon + label)
 * that sits inside a message card above its body content. Reads the header
 * label, inline icon, and accent swatch from MessageRenderingConfig.
 *
 * Returns null when there is no label to show, so call sites can render it
 * unconditionally without a conditional wrapper.
 */
export const KindHeader: React.FC<KindHeaderProps> = ({
  kindId,
  label,
  fallbackLabel = null,
  fallbackIcon,
  showIcon = false,
  className,
}) => {
  const { config } = useMessageRenderingConfig();
  const resolvedLabel = label !== undefined
    ? label
    : (headerLabelFor(config, kindId) ?? fallbackLabel);
  if (!resolvedLabel) return null;
  const iconName = iconNameFor(config, kindId) ?? fallbackIcon ?? null;
  const swatch = swatchFor(config, kindId);
  const swatchStyle = swatch ? { color: swatch } : undefined;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {showIcon && iconName && iconName !== "none" && (
        <span style={swatchStyle}>
          <IconRenderer name={iconName} className="h-4 w-4" />
        </span>
      )}
      <span
        className={headerClassNames(config)}
        style={{ fontFamily: typographyFontFamily(config.typography.header), ...swatchStyle }}
      >
        {resolvedLabel}
      </span>
    </div>
  );
};
