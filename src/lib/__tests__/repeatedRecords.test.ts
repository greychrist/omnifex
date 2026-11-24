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
// compact_boundary: same uuids, new cwd/gitBranch/slug.
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

// After /compact the CLI writes the last reply again: new uuid, same message id,
// every usage field 0.
describe('the reply the CLI re-writes after /compact', () => {
  const ZERO = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  const reply = (uuid: string, usage: Record<string, number>, id = 'msg_1'): JsonlNode =>
    classifyJsonlLine({
      type: 'assistant',
      uuid,
      timestamp: '2026-11-18T18:07:54.166Z',
      message: { id, role: 'assistant', content: [{ type: 'text', text: 'v0.5.50 is published' }], usage },
    })!;
  const original = reply('d083', { ...ZERO, cache_read_input_tokens: 420_000 });
  const copy = reply('d487', ZERO);

  it('drops the zero-usage copy of a message the tab already holds', () => {
    expect(withoutRepeatedRecords([original, copy])).toEqual([original]);
    expect(isRepeatedRecord([original], copy)).toBe(true);
  });

  // The CLI writes one record per content block.
  it('keeps a second record of the same message that has real usage', () => {
    const block = reply('e001', { ...ZERO, cache_read_input_tokens: 420_000 });
    expect(withoutRepeatedRecords([original, block])).toEqual([original, block]);
    expect(isRepeatedRecord([original], block)).toBe(false);
  });

  // A synthetic message (an API error, "No response requested") also has zero
  // usage, but its id is its own.
  it('keeps a zero-usage message whose id the tab has not seen', () => {
    const synthetic = reply('f001', ZERO, 'msg_synthetic');
    expect(withoutRepeatedRecords([original, synthetic])).toEqual([original, synthetic]);
    expect(isRepeatedRecord([original], synthetic)).toBe(false);
  });
});
