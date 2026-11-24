import React from "react";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/contexts/AccountsContext";
import { useTheme } from "@/hooks";
import { ICON_MAP } from "./IconPicker";
import { User } from "lucide-react";
import { buildThemedColors } from "./AccountBadge";

/** Not lucide's `message-square`: its body is too short to hold the 13px account glyph. */
const BUBBLE_PATH =
  "M6 1 H18 A5 5 0 0 1 23 6 V14 A5 5 0 0 1 18 19 H11 L6 23 V19 A5 5 0 0 1 1 14 V6 A5 5 0 0 1 6 1 Z";

const GLYPH_BOX = 24;
const ACCOUNT_ICON = 13;
/** Body centre (12,10) vs box centre (12,12). */
const ICON_Y_NUDGE = -2;

interface AccountTabGlyphProps {
  name: string;
  color?: string | null;
  icon?: string | null;
  active?: boolean;
  className?: string;
}

export const AccountTabGlyph: React.FC<AccountTabGlyphProps> = ({
  name,
  color: colorProp,
  icon,
  active = false,
  className,
}) => {
  const { getColor, getIcon } = useAccounts();
  const { theme } = useTheme();
  const color = colorProp ?? getColor(name);
  const resolvedIcon = icon ?? getIcon(name);
  const IconComponent = (resolvedIcon && ICON_MAP[resolvedIcon]) || User;

  // An SVG fill needs a real color, not the badge's Tailwind class strings.
  const colors = color
    ? buildThemedColors(color, theme)
    : {
        backgroundColor: "color-mix(in oklch, currentColor 15%, transparent)",
        color: "currentColor",
        borderColor: "color-mix(in oklch, currentColor 32%, transparent)",
      };

  return (
    <span
      title={name}
      data-testid="account-tab-glyph"
      className={cn(
        "relative inline-flex flex-shrink-0 items-center justify-center",
        active ? "opacity-100" : "opacity-80",
        className,
      )}
      style={{ width: GLYPH_BOX, height: GLYPH_BOX }}
    >
      <svg
        viewBox="0 0 24 24"
        width={GLYPH_BOX}
        height={GLYPH_BOX}
        className="absolute inset-0"
        aria-hidden="true"
      >
        <path
          d={BUBBLE_PATH}
          fill={colors.backgroundColor}
          stroke={colors.borderColor}
          strokeWidth={1.25}
          strokeLinejoin="round"
        />
      </svg>
      <IconComponent
        aria-hidden="true"
        className="relative"
        style={{
          width: ACCOUNT_ICON,
          height: ACCOUNT_ICON,
          color: colors.color,
          transform: `translateY(${String(ICON_Y_NUDGE)}px)`,
        }}
        strokeWidth={2.2}
      />
    </span>
  );
};
