import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { buildContextTimeline } from '../contextTimeline';

const LIMIT = 1_000_000;
const opts = { limit: LIMIT, jumpThresholdTokens: 50_000 };

const assistant = (total: number): JsonlNode =>
  ({
    kind: 'assistant',
    sessionId: 's1',
    receivedAt: '2026-07-30T10:00:00Z',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: total - 3,
          cache_creation_input_tokens: 1,
          output_tokens: 1,
        },
      },
    },
  }) as unknown as JsonlNode;

const sidechain = (total: number): JsonlNode => {
  const node = assistant(total) as unknown as { raw: Record<string, unknown> };
  node.raw.isSidechain = true;
  return node as unknown as JsonlNode;
};

const prompt = (): JsonlNode =>
  ({
    kind: 'user',
    sessionId: 's1',
    receivedAt: '2026-07-30T10:00:00Z',
    userKind: 'prompt',
    raw: { type: 'user', message: { role: 'user', content: 'hi' } },
  }) as unknown as JsonlNode;

const compactBoundary = (): JsonlNode =>
  ({
    kind: 'system',
    subtype: 'compact_boundary',
    sessionId: 's1',
    receivedAt: '2026-07-30T10:00:00Z',
    raw: { type: 'system', subtype: 'compact_boundary' },
  }) as unknown as JsonlNode;

describe('buildContextTimeline — sampling', () => {
  it('records a sample at each main assistant message', () => {
    const a = assistant(100_000);
    const b = assistant(140_000);
    const t = buildContextTimeline([a, prompt(), b], opts);
    expect(t.get(a)).toMatchObject({ tokens: 100_000, isSample: true });
    expect(t.get(b)).toMatchObject({ tokens: 140_000, isSample: true, delta: 40_000 });
  });

  it('carries the last value forward across rows with no usage', () => {
    const a = assistant(100_000);
    const p = prompt();
    const t = buildContextTimeline([a, p], opts);
    expect(t.get(p)).toMatchObject({ tokens: 100_000, isSample: false, delta: null });
  });

  it('has no entry before the first sample', () => {
    const p = prompt();
    const t = buildContextTimeline([p, assistant(100_000)], opts);
    expect(t.get(p)).toBeUndefined();
  });

  it('excludes subagent messages from the series', () => {
    const a = assistant(100_000);
    const sub = sidechain(900_000);
    const b = assistant(140_000);
    const t = buildContextTimeline([a, sub, b], opts);
    expect(t.get(sub)?.isSample).toBe(false);
    // The subagent's 900k must not become the baseline for b's delta.
    expect(t.get(b)?.delta).toBe(40_000);
  });
});

describe('buildContextTimeline — filtered rendering', () => {
  // ClaudeTranscript renders `displayableMessages` (hard-filtered), not
  // `messages`. Keying by node identity means the rail still resolves for the
  // rows that survive, and deltas stay measured across the hidden ones.
  it('resolves points for a filtered subset without shifting deltas', () => {
    const a = assistant(100_000);
    const hidden = assistant(400_000);
    const c = assistant(430_000);
    const all = [a, hidden, c];
    const timeline = buildContextTimeline(all, opts);

    const visible = all.filter((n) => n !== hidden);
    expect(visible.map((n) => timeline.get(n)?.tokens)).toEqual([100_000, 430_000]);
    // c's delta is still measured against the hidden message, not against a.
    expect(timeline.get(c)?.delta).toBe(30_000);
    expect(timeline.get(c)?.isJump).toBe(false);
  });
});

describe('buildContextTimeline — jumps', () => {
  it('flags a sample at or above the threshold', () => {
    const b = assistant(150_000);
    const t = buildContextTimeline([assistant(100_000), b], opts);
    expect(t.get(b)?.isJump).toBe(true);
  });

  it('leaves a sub-threshold step unflagged', () => {
    const b = assistant(149_999);
    const t = buildContextTimeline([assistant(100_000), b], opts);
    expect(t.get(b)?.isJump).toBe(false);
  });

  it('never flags the first sample, which has no baseline', () => {
    const a = assistant(400_000);
    const t = buildContextTimeline([a], opts);
    expect(t.get(a)).toMatchObject({ delta: null, isJump: false });
  });
});

describe('buildContextTimeline — compaction', () => {
  it('marks the first sample after a boundary as a reset and suppresses its delta', () => {
    const after = assistant(60_000);
    const t = buildContextTimeline([assistant(800_000), compactBoundary(), after], opts);
    expect(t.get(after)).toMatchObject({ isReset: true, delta: null, isJump: false });
  });

  it('resumes normal deltas on the sample after the reset', () => {
    const after = assistant(60_000);
    const later = assistant(75_000);
    const t = buildContextTimeline(
      [assistant(800_000), compactBoundary(), after, later],
      opts,
    );
    expect(t.get(later)).toMatchObject({ isReset: false, delta: 15_000 });
  });
});

describe('buildContextTimeline — fraction', () => {
  it('is the share of the window in use', () => {
    const a = assistant(250_000);
    expect(buildContextTimeline([a], opts).get(a)?.fraction).toBeCloseTo(0.25, 6);
  });

  it('clamps at 1 when context exceeds the limit', () => {
    const a = assistant(1_400_000);
    expect(buildContextTimeline([a], opts).get(a)?.fraction).toBe(1);
  });

  it('is 0 rather than NaN when the limit is unknown', () => {
    const a = assistant(250_000);
    const t = buildContextTimeline([a], { ...opts, limit: 0 });
    expect(t.get(a)?.fraction).toBe(0);
  });
});
