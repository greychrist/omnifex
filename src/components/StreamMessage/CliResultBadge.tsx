import React from 'react';
import type { JsonlNode } from '@/types/jsonl';
import { formatDurationMs } from '@/lib/duration';

interface Props {
  node: Extract<JsonlNode, { kind: 'cli-stream-result' }>;
}

/** Minimal placeholder badge for engine-mode result envelopes. */
export const CliResultBadge: React.FC<Props> = ({ node }) => {
  const { raw } = node;
  const subtype = typeof raw.subtype === 'string' ? raw.subtype : undefined;
  const durationMs = typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined;
  const isError = raw.is_error === true;

  return (
    <div
      className={[
        'flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-mono',
        isError
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-border bg-muted/40 text-muted-foreground',
      ].join(' ')}
    >
      <span className="font-semibold text-foreground/60">cli-stream-result</span>
      {subtype && (
        <>
          <span aria-hidden>·</span>
          <span>{subtype}</span>
        </>
      )}
      {durationMs !== undefined && (
        <>
          <span aria-hidden>·</span>
          <span>{formatDurationMs(durationMs)}</span>
        </>
      )}
      <span aria-hidden>·</span>
      <span className="text-muted-foreground/60">{node.receivedAt}</span>
    </div>
  );
};
