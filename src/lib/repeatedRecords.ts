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
 */
import type { JsonlNode } from '@/types/jsonl';
import { uuidOf } from './promptReconciliation';

/** `nodes` with every repeat of an earlier uuid removed; the input array itself when there are none. */
export function withoutRepeatedRecords(nodes: JsonlNode[]): JsonlNode[] {
  const seen = new Set<string>();
  const kept = nodes.filter((node) => {
    const uuid = uuidOf(node);
    if (uuid === null) return true;
    if (seen.has(uuid)) return false;
    seen.add(uuid);
    return true;
  });
  return kept.length === nodes.length ? nodes : kept;
}

/** True when `messages` already holds a record with `node`'s uuid. */
export function isRepeatedRecord(messages: JsonlNode[], node: JsonlNode): boolean {
  const uuid = uuidOf(node);
  return uuid !== null && messages.some((m) => uuidOf(m) === uuid);
}
