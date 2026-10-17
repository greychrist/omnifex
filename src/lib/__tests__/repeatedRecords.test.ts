import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import { withoutRepeatedRecords, isRepeatedRecord } from '@/lib/repeatedRecords';

const rec = (uuid: string, timestamp: string, cwd = '/repo'): JsonlNode =>
  classifyJsonlLine({
    type: 'assistant',
    uuid,
    timestamp,
    cwd,
    message: { role: 'assistant', content: [{ type: 'text', text: uuid }] },
  })!;

const echo = (text: string): JsonlNode => ({
  kind: 'user',
  userKind: 'prompt',
  sessionId: 's',
  receivedAt: '2026-10-16T14:00:00.000Z',
  raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } } as never,
});

// CLI 2.1.300 re-appends an earlier compacted segment just before a later
// compact_boundary: same uuids, new cwd/gitBranch/slug. Seen on three
// sessions 2026-10-12..16 (823–938 records each); the copies streamed into
// the tab as a day-old block, stalled the window, and on reload sat above the
// compaction, pushing that day's messages out of sight.
describe('withoutRepeatedRecords', () => {
  it('keeps the first copy of a record, in its original place', () => {
    const a = rec('a', '2026-10-15T00:43:00Z');
    const b = rec('b', '2026-10-15T00:44:00Z');
    const c = rec('c', '2026-10-16T14:00:00Z');
    const copies = [rec('a', '2026-10-15T00:43:00Z', '/wt'), rec('b', '2026-10-15T00:44:00Z', '/wt')];
    const d = rec('d', '2026-10-16T14:21:00Z');

    expect(withoutRepeatedRecords([a, b, c, ...copies, d])).toEqual([a, b, c, d]);
  });

  it('never drops a node without a uuid', () => {
    const nodes = [echo('one'), echo('one'), rec('a', '2026-10-15T00:43:00Z')];
    expect(withoutRepeatedRecords(nodes)).toEqual(nodes);
  });

  it('returns the input array itself when nothing repeats', () => {
    const nodes = [rec('a', '2026-10-15T00:43:00Z'), rec('b', '2026-10-15T00:44:00Z')];
    expect(withoutRepeatedRecords(nodes)).toBe(nodes);
  });
});

describe('isRepeatedRecord', () => {
  const messages = [echo('hi'), rec('a', '2026-10-15T00:43:00Z')];

  it('is true for a record whose uuid the tab already holds', () => {
    expect(isRepeatedRecord(messages, rec('a', '2026-10-15T00:43:00Z', '/wt'))).toBe(true);
  });

  it('is false for a new record and for a node without a uuid', () => {
    expect(isRepeatedRecord(messages, rec('z', '2026-10-16T14:00:00Z'))).toBe(false);
    expect(isRepeatedRecord(messages, echo('hi'))).toBe(false);
  });
});
