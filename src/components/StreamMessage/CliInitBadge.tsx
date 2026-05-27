import React from 'react';
import type { JsonlNode } from '@/types/jsonl';

interface Props {
  node: Extract<JsonlNode, { kind: 'cli-stream-init' }>;
}

/** Minimal placeholder badge for engine-mode system:init envelopes. */
export const CliInitBadge: React.FC<Props> = ({ node }) => {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-muted/40 text-xs text-muted-foreground font-mono">
      <span className="font-semibold text-foreground/60">cli-stream-init</span>
      {node.raw.model && (
        <>
          <span aria-hidden>·</span>
          <span>{String(node.raw.model)}</span>
        </>
      )}
      {node.raw.cwd && (
        <>
          <span aria-hidden>·</span>
          <span className="truncate max-w-xs">{String(node.raw.cwd)}</span>
        </>
      )}
      <span aria-hidden>·</span>
      <span className="text-muted-foreground/60">{node.receivedAt}</span>
    </div>
  );
};
