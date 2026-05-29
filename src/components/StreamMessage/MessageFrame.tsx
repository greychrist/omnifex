import * as React from 'react';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { resolveKind } from '@/lib/messageRenderingConfig';
import { MessageFrameCard } from './MessageFrameCard';
import { MessageFrameSideLine } from './MessageFrameSideLine';
import { MessageFrameCollapsible } from './MessageFrameCollapsible';

export interface MessageFrameProps {
  /** The dotted kind ID (e.g. `'user.prompt'`, `'system.informational'`).
   *  Resolved via `resolveKind`: merges the category default for the kind's
   *  origin with any per-kind override. Always returns a complete style —
   *  there is no missing-kind / unknown fallback. */
  streamKind: string;
  children: React.ReactNode;
  /** Optional toolbar node for card-presentation frames. Forwarded to
   *  `MessageFrameCard.actionBar` so it renders absolutely inside the card.
   *  Ignored for side-line presentation. */
  actionBar?: React.ReactNode;
  /** Optional message to forward to `MessageFrameCard` for the timestamp
   *  footer and debug raw-JSON copy button. */
  message?: import('@/types/jsonl').JsonlNode;
  /** Overrides the kind's configured `headerLabel` — used by the collapsible
   *  variant for content-derived titles (e.g. "Skill: …"). Caller decides
   *  precedence (e.g. a user-customized config header should win). */
  headerOverride?: string;
}

/**
 * Variant-switching shell for the message timeline.
 *
 * Reads the kind config for `streamKind` (falling back to `unknown`) and
 * renders either `MessageFrameCard` or `MessageFrameSideLine` based on the
 * kind's `presentation` field. This is the single choke-point that drives
 * every presentation variant; callers only need to know `streamKind`.
 */
export const MessageFrame: React.FC<MessageFrameProps> = ({ streamKind, children, actionBar, message, headerOverride }) => {
  const { config } = useMessageRenderingConfig();
  const kind = resolveKind(config, streamKind);

  // When the kind opts into raw-payload display (today only `unknown`, but
  // the field is a general escape hatch), append a collapsible <details>
  // block with the pretty-printed message JSON. Sits after the existing
  // children so it works for both card and side-line variants.
  const rawPayload = kind.showRawPayload === true && message ? (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground font-mono select-none hover:text-foreground">
        Raw payload
      </summary>
      <pre className="mt-1 p-2 rounded border bg-muted/50 text-[10px] font-mono overflow-x-auto whitespace-pre-wrap break-words leading-tight">
        {JSON.stringify((message as unknown as { raw?: unknown }).raw, null, 2)}
      </pre>
    </details>
  ) : null;

  if (kind.presentation === 'card') {
    return (
      <div data-frame-variant="card">
        <MessageFrameCard kindId={streamKind} alignment={kind.alignment} actionBar={actionBar} message={message}>
          {children}
          {rawPayload}
        </MessageFrameCard>
      </div>
    );
  }

  if (kind.presentation === 'collapsible') {
    return (
      <div data-frame-variant="collapsible">
        <MessageFrameCollapsible
          kindId={streamKind}
          headerLabel={headerOverride ?? kind.headerLabel}
          actionBar={actionBar}
        >
          {children}
          {rawPayload}
        </MessageFrameCollapsible>
      </div>
    );
  }

  // 'side-line' (and any future presentation variants fall through here).
  // Resolve the icon-chip config (per-kind override → global default) so
  // the side-line icon honors the same bordered/bg-opacity knobs as cards.
  const iconBordered = kind.iconBordered ?? config.typography.icon.bordered;
  const iconBgOpacity = kind.iconBgOpacity ?? config.typography.icon.bgOpacity;
  return (
    <div data-frame-variant="side-line">
      <MessageFrameSideLine
        iconName={kind.icon}
        accentColor={kind.accentColor}
        borderStyle={kind.borderStyle}
        iconBordered={iconBordered}
        iconBgOpacity={iconBgOpacity}
      >
        {children}
      </MessageFrameSideLine>
      {rawPayload && <div className="ml-6">{rawPayload}</div>}
    </div>
  );
};
