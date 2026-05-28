import * as React from 'react';
import { IconRenderer } from '@/components/settings-panels/appearance/iconMap';
import { DEFAULT_PALETTE, isHexColor } from '@/lib/messageRenderingConfig';
import type { IconName, BorderStyle } from '@/lib/messageRenderingConfig';

export interface MessageFrameSideLineProps {
  iconName: IconName;
  accentColor: string;
  borderStyle: BorderStyle;
  children: React.ReactNode;
}

/**
 * Resolve an accent color (palette name or hex) to a CSS hex swatch.
 * Mirrors the same two-form resolution used by `accentFor` in accentStyle.ts,
 * but operates on a raw `accentColor` string instead of a kindId + config.
 */
function resolveAccentSwatch(accentColor: string): string {
  if (isHexColor(accentColor)) return accentColor;
  const entry = DEFAULT_PALETTE[accentColor as keyof typeof DEFAULT_PALETTE];
  return entry?.swatch ?? '#6b7280';
}

/**
 * Side-line presentation variant — a 2px left accent bar with an inline icon
 * and one line of text. No card chrome. Used for low-weight status messages
 * (tool results, bookkeeping, system signals) that don't warrant a full card.
 */
export const MessageFrameSideLine: React.FC<MessageFrameSideLineProps> = ({
  iconName,
  accentColor,
  borderStyle,
  children,
}) => {
  const swatch = resolveAccentSwatch(accentColor);

  return (
    <div
      className="flex items-center gap-2 py-1 px-2 rounded-md border"
      style={{ borderColor: `${swatch}55`, borderStyle, backgroundColor: `${swatch}33` }}
    >
      <div
        data-testid="side-line-bar"
        style={{
          borderLeft: `2px ${borderStyle} ${swatch}`,
          height: '1.25rem',
          marginRight: '0.5rem',
        }}
      />
      <span style={{ color: swatch }}>
        <IconRenderer name={iconName} className="h-3.5 w-3.5" />
      </span>
      <span className="text-sm text-foreground/80">{children}</span>
    </div>
  );
};
