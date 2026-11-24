import * as React from 'react';
import type { JsonlNode } from '@/types/jsonl';
import { CopyButton } from '@/components/ui/copy-button';
import { RawJsonPopover } from './RawJsonPopover';

function dateOf(node: JsonlNode): Date | null {
  const at = (node as { receivedAt?: string | null }).receivedAt;
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

function stampOf(node: JsonlNode): string | null {
  const d = dateOf(node);
  if (!d) return null;
  const date = `${String(d.getMonth() + 1)}-${String(d.getDate())}-${String(d.getFullYear())}`;
  return `${date} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
}

export function Stamp({ node }: { node: JsonlNode }) {
  const stamp = stampOf(node);
  return stamp ? <span data-message-stamp className="mr-1">{stamp}</span> : null;
}

/** A thunk: serialized only when the panel opens. */
export function rawOfNodes(nodes: JsonlNode[]): () => string {
  return () => {
    const raws = nodes.map((n) => (n as { raw?: unknown }).raw ?? n);
    return JSON.stringify(raws.length === 1 ? raws[0] : raws, null, 2);
  };
}

export function HoverActionsRow({
  raw,
  copy,
  stampNode,
  children,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  raw: () => string;
  copy: () => string;
  stampNode?: JsonlNode;
  children: React.ReactNode;
}) {
  return (
    <div className="group/row flex w-full min-w-0 items-start gap-2" {...props}>
      <div className="min-w-0 flex-1">{children}</div>
      <div
        data-record-actions
        className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"
      >
        {stampNode && <Stamp node={stampNode} />}
        <CopyButton getText={copy} className="h-6 w-6" />
        <RawJsonPopover text={raw} />
      </div>
    </div>
  );
}
