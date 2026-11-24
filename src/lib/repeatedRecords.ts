/**
 * CLI 2.1.300 can re-append a compacted segment (same uuids) before a later `compact_boundary`; the first copy wins.
 * After /compact the CLI rewrites the last reply with a new uuid, the same `message.id` and zero usage. `message.id` alone
 * is not identity: the CLI writes one record per content block, all sharing it.
 */
import type { JsonlNode } from '@/types/jsonl';
import { uuidOf } from './promptReconciliation';

export function withoutRepeatedRecords(nodes: JsonlNode[]): JsonlNode[] {
  const seen = new Set<string>();
  const messageIds = new Set<string>();
  const kept = nodes.filter((node) => {
    const copyOf = zeroUsageMessageId(node);
    if (copyOf !== null && messageIds.has(copyOf)) return false;
    const id = messageIdOf(node);
    if (id !== null) messageIds.add(id);
    const uuid = uuidOf(node);
    if (uuid === null) return true;
    if (seen.has(uuid)) return false;
    seen.add(uuid);
    return true;
  });
  return kept.length === nodes.length ? nodes : kept;
}

export function isRepeatedRecord(messages: JsonlNode[], node: JsonlNode): boolean {
  const uuid = uuidOf(node);
  if (uuid !== null && messages.some((m) => uuidOf(m) === uuid)) return true;
  const copyOf = zeroUsageMessageId(node);
  return copyOf !== null && messages.some((m) => messageIdOf(m) === copyOf);
}

interface AssistantRaw { message?: { id?: unknown; usage?: Record<string, unknown> } }

function messageIdOf(node: JsonlNode): string | null {
  if (node.kind !== 'assistant') return null;
  const id = (node.raw as AssistantRaw).message?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function zeroUsageMessageId(node: JsonlNode): string | null {
  if (node.kind !== 'assistant') return null;
  const id = messageIdOf(node);
  if (id === null) return null;
  const usage = (node.raw as AssistantRaw).message?.usage;
  if (!usage) return null;
  const counts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
  return counts.every((k) => !usage[k]) ? id : null;
}
