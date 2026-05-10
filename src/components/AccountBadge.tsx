import React from "react";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/contexts/AccountsContext";
import { useTheme } from "@/hooks";
import { ICON_MAP } from "./IconPicker";
import { User } from "lucide-react";

const FALLBACK_COLORS = [
  "bg-blue-500/20 text-blue-400 border-blue-500/30 dark:text-blue-400",
  "bg-purple-500/20 text-purple-400 border-purple-500/30",
  "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  "bg-amber-500/20 text-amber-400 border-amber-500/30",
  "bg-rose-500/20 text-rose-400 border-rose-500/30",
  "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
];

function getFallbackColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

/**
 * Theme-aware style cluster for the colored badge variants. The original
 * approach (hex + alpha against `transparent`) reads well over the dark
 * `gray` theme but collapses on `light` — a bright account color (yellow,
 * cyan, rose) becomes ~white on a near-white background, with no contrast
 * for either text or border.
 *
 * The fix is per-theme color mixing done in the browser via `color-mix(...
 * in oklch ...)`:
 *   - gray (dark) — mix the account color with `transparent` (prior look).
 *   - light       — mix toward white for the surface (soft tint instead
 *                   of low-alpha white-on-white) and toward black for the
 *                   foreground (darken bright hues so they read against a
 *                   light background). The border tracks the foreground
 *                   so it stays visible at any hue.
 *
 * `color-mix(in oklch, ...)` ships in Chromium 111+, well below the
 * Electron baseline this repo runs on, so no fallback path is needed.
 */
function buildThemedColors(color: string, theme: "gray" | "light"): {
  backgroundColor: string;
  color: string;
  borderColor: string;
} {
  if (theme === "light") {
    return {
      backgroundColor: `color-mix(in oklch, ${color} 18%, white)`,
      color: `color-mix(in oklch, ${color} 70%, black)`,
      borderColor: `color-mix(in oklch, ${color} 55%, white)`,
    };
  }
  // gray (default / dark)
  return {
    backgroundColor: `color-mix(in oklch, ${color} 20%, transparent)`,
    color,
    borderColor: `color-mix(in oklch, ${color} 30%, transparent)`,
  };
}

interface AccountBadgeProps {
  name: string;
  color?: string | null;
  icon?: string | null;
  accountType?: string | null;
  variant?: "full" | "compact";
  /**
   * Text size of the "full" badge. Defaults to `xs` (11px text + 14px icon)
   * — the historical sizing every existing call site relies on. Use `sm`
   * (12px text / `text-xs` + 15px icon) when embedding the badge inside a
   * `text-xs` container like a select dropdown so the badge inherits the
   * surrounding scale instead of looking like an undersized chip. Ignored
   * by the `compact` variant — that's a fixed 18px icon-only square.
   */
  size?: "xs" | "sm";
  className?: string;
}

export const AccountBadge: React.FC<AccountBadgeProps> = ({
  name,
  color: colorProp,
  icon,
  accountType: accountTypeProp,
  variant = "full",
  size = "xs",
  className,
}) => {
  const { getColor, getIcon, getAccountType } = useAccounts();
  const { theme } = useTheme();
  const color = colorProp ?? getColor(name);
  const resolvedIcon = icon ?? getIcon(name);
  const resolvedType = accountTypeProp ?? getAccountType(name);
  const IconComponent = (resolvedIcon && ICON_MAP[resolvedIcon]) || User;
  // Per-size knobs for the "full" variant. `text-[11px]` is the historical
  // baseline; `text-xs` is 12px and matches shadcn's select / dropdown
  // chrome. Icon size scales ~25% above text height in both — readable
  // without dwarfing the label.
  const textSizeClass = size === "sm" ? "text-xs" : "text-[11px]";
  const iconSizeClass = size === "sm" ? "h-[15px] w-[15px]" : "h-[14px] w-[14px]";
  // The fallback (no-color) path uses an icon that's slightly smaller than
  // its text height for visual balance with the muted color stack.
  const fallbackIconSizeClass = size === "sm" ? "h-[12px] w-[12px]" : "h-[11px] w-[11px]";

  if (variant === "compact") {
    if (color) {
      // Compact uses an inset box-shadow as the "border" so the chip
      // stays a fixed 18px square. Same theme-aware mix as the full
      // variant, applied to the three style fields the chip exposes.
      const compactColors = buildThemedColors(color, theme);
      return (
        <span
          title={name}
          className={cn(
            "inline-flex items-center justify-center rounded h-[18px] w-[18px] flex-shrink-0",
            className,
          )}
          style={{
            backgroundColor: compactColors.backgroundColor,
            color: compactColors.color,
            boxShadow: `inset 0 0 0 1px ${compactColors.borderColor}`,
          }}
        >
          <IconComponent className="h-[13px] w-[13px]" strokeWidth={2.2} />
        </span>
      );
    }
    return (
      <span
        title={name}
        className={cn(
          "inline-flex items-center justify-center rounded h-[18px] w-[18px] flex-shrink-0",
          getFallbackColor(name),
          className,
        )}
      >
        <IconComponent className="h-[13px] w-[13px]" strokeWidth={2.2} />
      </span>
    );
  }

  if (color) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded border px-2 py-0.5 font-medium whitespace-nowrap",
          textSizeClass,
          className,
        )}
        style={buildThemedColors(color, theme)}
      >
        {/* Icon is intentionally ~25% larger than the label to read
            cleaner. The pill height is driven by the line-height of the
            text, so the icon doesn't change the badge's overall size. */}
        <IconComponent className={iconSizeClass} strokeWidth={2.2} />
        {name}
        {resolvedType && (
          <span className="opacity-70">: {resolvedType}</span>
        )}
      </span>
    );
  }

  const fallbackClass = getFallbackColor(name);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-2 py-0.5 font-medium whitespace-nowrap",
        textSizeClass,
        fallbackClass,
        className,
      )}
    >
      <IconComponent className={fallbackIconSizeClass} strokeWidth={2.2} />
      {name}
    </span>
  );
};
