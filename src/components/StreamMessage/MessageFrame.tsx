import * as React from 'react';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { MessageFrameCard } from './MessageFrameCard';
import { MessageFrameSideLine } from './MessageFrameSideLine';

export interface MessageFrameProps {
  /** The dotted kind ID (e.g. `'user.prompt'`, `'system.informational'`).
   *  If not found in config, falls back to the `unknown` kind. */
  streamKind: string;
  children: React.ReactNode;
}

/**
 * Variant-switching shell for the message timeline.
 *
 * Reads the kind config for `streamKind` (falling back to `unknown`) and
 * renders either `MessageFrameCard` or `MessageFrameSideLine` based on the
 * kind's `presentation` field. This is the single choke-point that drives
 * every presentation variant; callers only need to know `streamKind`.
 */
export const MessageFrame: React.FC<MessageFrameProps> = ({ streamKind, children }) => {
  const { config } = useMessageRenderingConfig();
  const kind = config.kinds[streamKind] ?? config.kinds['unknown'];

  if (!kind) {
    // Safety net: config has no 'unknown' entry (shouldn't happen with defaults).
    return <div data-frame-variant="missing">{children}</div>;
  }

  if (kind.presentation === 'card') {
    return (
      <div data-frame-variant="card">
        <MessageFrameCard kindId={kind.id}>
          {children}
        </MessageFrameCard>
      </div>
    );
  }

  // 'side-line' (and any future presentation variants fall through here)
  return (
    <MessageFrameSideLine
      iconName={kind.icon}
      accentColor={kind.accentColor}
      borderStyle={kind.borderStyle}
    >
      {children}
    </MessageFrameSideLine>
  );
};
