import type { JsonlNode } from '@/types/jsonl';

/**
 * How long an input sat in the CLI's input queue before the CLI took it up.
 *
 * `queue-operation` records trace that queue: every prompt, task notification
 * and agent message is `enqueue`d on arrival and `dequeue`d when a turn starts
 * on it — immediately when the CLI is idle, after the running turn otherwise.
 * An input folded into the running turn leaves by `remove`
 * (reason `absorbed_mid_turn`) instead, so it must not pair with a dequeue.
 *
 * Pairs FIFO. Null for anything but a dequeue with a matching enqueue. Computed
 * once per transcript array: every dequeue row asks, and each walk is O(n).
 */
export function queueWaitMs(messages: readonly JsonlNode[], node: JsonlNode): number | null {
  let waits = cache.get(messages);
  if (!waits) {
    waits = computeWaits(messages);
    cache.set(messages, waits);
  }
  return waits.get(node) ?? null;
}

const cache = new WeakMap<readonly JsonlNode[], Map<JsonlNode, number>>();

function computeWaits(messages: readonly JsonlNode[]): Map<JsonlNode, number> {
  const waits = new Map<JsonlNode, number>();
  const pending: { at: number; content: string | undefined }[] = [];
  for (const m of messages) {
    if (m.kind !== 'queue-operation') continue;
    const at = Date.parse(m.raw.timestamp ?? '');
    if (m.raw.operation === 'enqueue') {
      pending.push({ at, content: m.raw.content });
    } else if (m.raw.operation === 'remove') {
      const i = pending.findIndex((p) => p.content !== undefined && p.content === m.raw.content);
      pending.splice(i === -1 ? 0 : i, 1);
    } else if (m.raw.operation === 'dequeue') {
      const head = pending.shift();
      if (head && Number.isFinite(head.at) && Number.isFinite(at)) waits.set(m, at - head.at);
    }
  }
  return waits;
}
