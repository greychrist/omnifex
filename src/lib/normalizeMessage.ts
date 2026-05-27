import type { JsonlNode } from '@/types/jsonl';

/**
 * Normalize a `JsonlNode` so that for `assistant` and `user` nodes,
 * `raw.message.content` is always an array of typed blocks rather than a
 * bare string. All other node kinds pass through unchanged.
 *
 * This replaces the combination of `jsonlNodeToStreamMessage` + `normalizeMessageContent`
 * that was used before the adapter was deleted (Task 6).
 */
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
