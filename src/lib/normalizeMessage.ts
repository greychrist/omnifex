import type { JsonlNode } from '@/types/jsonl';

export function normalizeJsonlNode(node: JsonlNode): JsonlNode {
  if (node.kind !== 'assistant' && node.kind !== 'user') return node;
  const raw = node.raw as { message?: unknown };
  const inner = raw.message;
  if (!inner || typeof inner !== 'object') return node;
  const content = (inner as { content?: unknown }).content;
  if (typeof content !== 'string') return node;
  const nextContent =
    content.length === 0 ? [] : [{ type: 'text', text: content }];
  return {
    ...node,
    raw: {
      ...node.raw,
      message: {
        ...(inner as Record<string, unknown>),
        content: nextContent,
      },
    },
  } as unknown as JsonlNode;
}
