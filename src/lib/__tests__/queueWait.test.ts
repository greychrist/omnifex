import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { queueWaitMs } from '../queueWait';

const op = (operation: string, timestamp: string, content?: string): JsonlNode =>
  ({ kind: 'queue-operation', sessionId: 's', receivedAt: timestamp, raw: { type: 'queue-operation', operation, timestamp, ...(content !== undefined && { content }) } }) as unknown as JsonlNode;

describe('queueWaitMs', () => {
  it('measures a dequeue from the enqueue it pairs with', () => {
    const enq = op('enqueue', '2026-09-28T15:00:00.000Z');
    const deq = op('dequeue', '2026-09-28T15:00:42.500Z');
    expect(queueWaitMs([enq, deq], deq)).toBe(42500);
  });

  it('pairs first in, first out when inputs pile up behind a turn', () => {
    const e1 = op('enqueue', '2026-09-28T15:00:00.000Z');
    const e2 = op('enqueue', '2026-09-28T15:00:10.000Z');
    const d1 = op('dequeue', '2026-09-28T15:00:30.000Z');
    const d2 = op('dequeue', '2026-09-28T15:00:31.000Z');
    const all = [e1, e2, d1, d2];
    expect(queueWaitMs(all, d1)).toBe(30000);
    expect(queueWaitMs(all, d2)).toBe(21000);
  });

  // An input absorbed into the running turn leaves the queue by `remove`, not
  // `dequeue` — it must not be paired with a later dequeue.
  it('drops a removed input by its content before pairing', () => {
    const e1 = op('enqueue', '2026-09-28T15:00:00.000Z', '<task-notification>a</task-notification>');
    const e2 = op('enqueue', '2026-09-28T15:00:05.000Z');
    const rm = op('remove', '2026-09-28T15:00:06.000Z', '<task-notification>a</task-notification>');
    const d = op('dequeue', '2026-09-28T15:00:09.000Z');
    expect(queueWaitMs([e1, e2, rm, d], d)).toBe(4000);
  });

  it('is null for anything but a paired dequeue', () => {
    const enq = op('enqueue', '2026-09-28T15:00:00.000Z');
    const orphan = op('dequeue', '2026-09-28T15:00:01.000Z');
    expect(queueWaitMs([enq], enq)).toBeNull();
    expect(queueWaitMs([orphan], orphan)).toBeNull();
  });
});
