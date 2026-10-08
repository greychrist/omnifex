import * as React from 'react';
import { IconRenderer } from '@/components/settings-panels/appearance/iconMap';
import { isHexColor } from '@/lib/messageRenderingConfig';
import type { IconName, BorderStyle } from '@/lib/messageRenderingConfig';
import { borderAlphaHex } from '@/lib/accentStyle';

export interface MessageFrameSideLineProps {
  iconName: IconName;
  accentColor: string;
  borderStyle: BorderStyle;
  /** Outline opacity in percent — the config's `cardBorderOpacity`. */
  borderOpacity: number;
  /** When true, the inline icon renders inside an accent-tinted chip
   *  (border + background fill) instead of as a bare glyph. Mirrors the
   *  card icon's `iconBordered` knob. Defaults to false. */
  iconBordered?: boolean;
  /** Chip background fill opacity (0–100) of the chat background, when
   *  `iconBordered` is true. Ignored otherwise. Defaults to 100. */
  iconBgOpacity?: number;
  /** Optional toolbar (a `CardActionBar` with `placement="inline"`). Sits at
   *  the end of the row rather than overlaying it: the row is ~28px tall, so
   *  an absolutely-positioned bar would spill out of it. */
  actionBar?: React.ReactNode;
  children: React.ReactNode;
}

/** Neutral grey for an accent that is not a hex (the config converts or
 *  drops anything else on load, so this is only reached by hand-built data). */
const FALLBACK_SWATCH = '#6b7280';

/**
 * Side-line presentation variant — a 2px left accent bar with an inline icon
 * and one line of text. No card chrome. Used for low-weight status messages
 * (tool results, bookkeeping, system signals) that don't warrant a full card.
 */
export const MessageFrameSideLine: React.FC<MessageFrameSideLineProps> = ({
  iconName,
  accentColor,
  borderStyle,
  borderOpacity,
  iconBordered = false,
  iconBgOpacity = 100,
  actionBar,
  children,
}) => {
  const swatch = isHexColor(accentColor) ? accentColor : FALLBACK_SWATCH;
  const borderColor = `${swatch}${borderAlphaHex(borderOpacity)}`;

  const icon = <IconRenderer name={iconName} className="h-3.5 w-3.5" />;
  const op = Math.max(0, Math.min(100, iconBgOpacity));
  const iconEl = iconBordered ? (
    <span
      className="flex items-center justify-center shrink-0 border rounded p-0.5"
      style={{
        color: swatch,
        borderColor,
        backgroundColor: `color-mix(in oklch, var(--color-background) ${op}%, transparent)`,
      }}
    >
      {icon}
    </span>
  ) : (
    <span style={{ color: swatch }}>{icon}</span>
  );

  return (
    <div
      className="flex items-center gap-2 py-1 px-2 rounded-md border"
      style={{ borderColor, borderStyle, backgroundColor: `${swatch}33` }}
    >
      <div
        data-testid="side-line-bar"
        style={{
          borderLeft: `2px ${borderStyle} ${swatch}`,
          height: '1.25rem',
          marginRight: '0.5rem',
        }}
      />
      {iconEl}
      <span className="text-sm text-foreground/80 min-w-0">{children}</span>
      {actionBar}
    </div>
  );
};
