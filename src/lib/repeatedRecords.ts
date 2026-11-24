/**
 * One row per persisted record: a `uuid` the tab already holds is dropped.
 *
 * CLI 2.1.300 can re-append an earlier compacted segment to the transcript
 * just before a later `compact_boundary` — the same records, same uuids, with
 * only `cwd` / `gitBranch` / `slug` restamped to the session's current
 * worktree. Seen on three sessions 2026-10-12..16, 823–938 records each.
 * Unfiltered, the copies streamed into the tab as a block of day-old rows
 * (which stalled the window long enough for the daemon to drop it), and after
 * a reload they sat above the compaction, pushing that day's messages up out
 * of sight.
 *
 * The CLI itself treats `uuid` as a record's identity, so the first copy is
 * kept, in its original place. Nodes without a uuid — the optimistic prompt
 * echo, stream-only frames — are never dropped; see promptReconciliation.ts.
 *
 * A second kind of copy: after /compact the CLI writes the last reply in
 * again with a NEW uuid, the same `message.id`, and every usage field 0
 * (session 57dcbf21, 2026-11-18). It rendered as a second copy of the reply,
 * took the turn's "Answer" label from the original, and gave the context rail
 * a "0". Matching on the id alone would be wrong — the CLI writes one record
 * per content block, all sharing it — so only a zero-usage record of a
 * message already held counts. A synthetic message (an API error) also has
 * zero usage, but an id of its own.
 */
import type { JsonlNode } from '@/types/jsonl';
import { uuidOf } from './promptReconciliation';

/** `nodes` with every repeat of an earlier record removed; the input array itself when there are none. */
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

/** True when `messages` already holds `node`: its uuid, or the message it is a zero-usage copy of. */
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

/** The message id of an assistant record whose usage is present and all zero. */
function zeroUsageMessageId(node: JsonlNode): string | null {
  if (node.kind !== 'assistant') return null;
  const id = messageIdOf(node);
  if (id === null) return null;
  const usage = (node.raw as AssistantRaw).message?.usage;
  if (!usage) return null;
  const counts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
  return counts.every((k) => !usage[k]) ? id : null;
}
