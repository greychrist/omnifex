import React from "react";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/contexts/AccountsContext";
import { useTheme } from "@/hooks";
import { ICON_MAP } from "./IconPicker";
import { User } from "lucide-react";
import { buildThemedColors } from "./AccountBadge";

/**
 * Speech-bubble silhouette, drawn at a 24×24 viewBox.
 *
 * Deliberately NOT lucide's `message-square`: that path's body runs y=3..17,
 * so at any size where a 13px account glyph fits inside it the bubble has to
 * grow past 28px and starts to dominate the tab. This one gives the body the
 * full y=1..19 and hangs a smaller tail off the bottom-left, which fits the
 * same glyph inside a 24px box.
 *
 * Body interior is x=1..23, y=1..19 — so its centre is (12, 10), two units
 * above the box centre. That offset is why the glyph below is nudged up.
 */
const BUBBLE_PATH =
  "M6 1 H18 A5 5 0 0 1 23 6 V14 A5 5 0 0 1 18 19 H11 L6 23 V19 A5 5 0 0 1 1 14 V6 A5 5 0 0 1 6 1 Z";

/** Rendered box. The bubble body is 22×18 inside this, which clears 13px. */
const GLYPH_BOX = 24;
/** Account icon size — unchanged from the compact AccountBadge chip. */
const ACCOUNT_ICON = 13;
/** Body centre (12,10) vs box centre (12,12). */
const ICON_Y_NUDGE = -2;

interface AccountTabGlyphProps {
  /** Account name — resolves colour/icon when they aren't passed, and titles the glyph. */
  name: string;
  color?: string | null;
  icon?: string | null;
  /** Dim the whole glyph on an inactive tab, matching the old type icon. */
  active?: boolean;
  className?: string;
}

/**
 * The chat tab's type icon and its account chip, collapsed into one mark.
 *
 * Before this, a chat tab carried a plain 15px `MessageSquare` on the left and
 * a separate 18px coloured account square on the right — two glyphs, one of
 * which said "this is a chat" on a strip where nearly everything is a chat.
 * Here the bubble itself takes the account's colour and holds the account's
 * icon, so one mark answers "whose session is this?" and keeps the chat
 * silhouette that made the tab type readable.
 *
 * Colours come from the same `buildThemedColors` mix the badge uses, so the
 * two stay identical across the light/gray themes.
 */
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

  // No account colour configured: fall back to a neutral mix off the inherited
  // text colour rather than the badge's hashed Tailwind palette — those are
  // class strings, and an SVG fill needs a real colour value.
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
