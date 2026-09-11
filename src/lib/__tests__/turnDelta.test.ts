import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { classifyJsonlLine } from '../jsonlClassifier';
import { DEFAULT_CONTEXT_JUMP_TOKENS, turnContextTotal, turnDeltaSeries } from '../turnDelta';

/** An assistant turn whose four usage components sum to `total`. */
const assistant = (total: number, receivedAt = '2026-07-30T10:00:00Z'): JsonlNode =>
  ({
    kind: 'assistant',
    sessionId: 's1',
    receivedAt,
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

/** A prompt the human actually typed — the anchor for a turn. */
const prompt = (uuid = 'p1'): JsonlNode =>
  ({
    kind: 'user',
    sessionId: 's1',
    receivedAt: '2026-07-30T10:00:00Z',
    userKind: 'prompt',
    raw: { type: 'user', uuid, message: { role: 'user', content: 'hi' } },
  }) as unknown as JsonlNode;

/** A tool_result the harness wrote back. Not a turn boundary. */
const toolResult = (): JsonlNode =>
  ({
    kind: 'user',
    sessionId: 's1',
    receivedAt: '2026-07-30T10:00:00Z',
    userKind: 'tool-result',
    raw: { type: 'user', message: { role: 'user', content: [] } },
  }) as unknown as JsonlNode;

/** A subagent's assistant message. Its usage describes ITS context, not ours. */
const sidechain = (total: number): JsonlNode => {
  const node = assistant(total) as unknown as { raw: Record<string, unknown> };
  node.raw.isSidechain = true;
  return node as unknown as JsonlNode;
};

/** A live-forwarded subagent message (--forward-subagent-text). Same exclusion. */
const forwarded = (total: number): JsonlNode => {
  const node = assistant(total) as unknown as { raw: Record<string, unknown> };
  node.raw.parent_tool_use_id = 'toolu_123';
  return node as unknown as JsonlNode;
};

const compactBoundary = (): JsonlNode =>
  ({
    kind: 'system',
    subtype: 'compact_boundary',
    sessionId: 's1',
    receivedAt: '2026-07-30T10:00:00Z',
    raw: { type: 'system', subtype: 'compact_boundary' },
  }) as unknown as JsonlNode;

/**
 * The /compact summary. A `user` record, but nothing the human typed. Built
 * through the real classifier rather than hand-stamped, so this stays a
 * regression test: if classifyUser stops recognising the record it goes back
 * to `userKind: 'prompt'` and these expectations break.
 */
const compactSummary = (): JsonlNode =>
  classifyJsonlLine({
    type: 'user',
    sessionId: 's1',
    timestamp: '2026-07-30T10:00:00Z',
    uuid: 'cs1',
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: { role: 'user', content: 'Session continued…' },
  }) as JsonlNode;

describe('turnContextTotal', () => {
  it('sums input + cache_read + cache_creation + output', () => {
    expect(turnContextTotal(assistant(477_456))).toBe(477_456);
  });

  it('is null for a turn with no usage', () => {
    expect(turnContextTotal(prompt())).toBeNull();
  });

  // A subagent's usage describes the subagent's own context window. Counting
  // it as main-thread context invents jumps that never happened.
  it('is null for subagent messages', () => {
    expect(turnContextTotal(sidechain(900_000))).toBeNull();
    expect(turnContextTotal(forwarded(900_000))).toBeNull();
  });
});

// CLI 2.1.265: a forked skill's kickoff prompt streams as a user envelope
// carrying `parent_tool_use_id`. It classifies as userKind 'prompt', so
// without an exclusion it anchored the turn — splitting one real turn in two
// and measuring the delta from the middle of it.
describe('forked subagent / skill kickoff prompts are not turn anchors', () => {
  const forwardedPrompt = (): JsonlNode =>
    ({
      kind: 'user',
      sessionId: 's1',
      receivedAt: '2026-07-30T10:00:00Z',
      userKind: 'prompt',
      raw: {
        type: 'user',
        uuid: 'fork1',
        parent_tool_use_id: 'toolu_SKILL_1',
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x' }] },
      },
    }) as unknown as JsonlNode;

  it('anchors on the human prompt, not the forwarded one', () => {
    const messages = [assistant(100_000), prompt('p1'), assistant(120_000), forwardedPrompt(), assistant(130_000)];
    const series = turnDeltaSeries(messages);

    // One turn, not two: 130_000 - 100_000. Anchoring at the fork would split
    // the turn in half and report 10_000 for its second piece.
    expect(series).toHaveLength(1);
    expect(series[0].deltaTokens).toBe(30_000);
    expect(series[0].prevTotal).toBe(100_000);
  });

  it('yields no turn when the only prompt is a forwarded one', () => {
    expect(turnDeltaSeries([assistant(100_000), forwardedPrompt(), assistant(130_000)])).toEqual([]);
  });
});

describe('turnDeltaSeries', () => {
  // The popover's "Recent events" is a per-turn log, so unlike lastTurnDelta
  // this keeps the entries that one deliberately suppresses: shrinks and
  // compactions are exactly what a history is for.
  it('emits one entry per prompt-anchored turn', () => {
    const messages = [
      assistant(100_000),
      prompt('p1'),
      assistant(140_000),
      toolResult(),
      assistant(180_000),
      prompt('p2'),
      assistant(190_000),
    ];

    const series = turnDeltaSeries(messages);
    expect(series.map((e) => e.anchorId)).toEqual(['p1', 'p2']);
    // p1 spans its whole tool loop: 180k - 100k, not 140k - 100k.
    expect(series[0].deltaTokens).toBe(80_000);
    expect(series[1].deltaTokens).toBe(10_000);
    expect(series[1].prevTotal).toBe(180_000);
  });

  it('skips a turn with no baseline before it', () => {
    expect(turnDeltaSeries([prompt('p1'), assistant(120_000)])).toEqual([]);
  });

  it('marks a compaction and keeps its negative delta', () => {
    const messages = [
      assistant(500_000),
      prompt('p1'),
      compactBoundary(),
      assistant(80_000),
    ];

    const series = turnDeltaSeries(messages);
    expect(series).toHaveLength(1);
    expect(series[0].compacted).toBe(true);
    expect(series[0].deltaTokens).toBe(-420_000);
  });

  it('ignores subagent usage, like every other per-turn metric here', () => {
    const messages = [assistant(100_000), prompt('p1'), sidechain(900_000), assistant(130_000)];
    expect(turnDeltaSeries(messages)[0].deltaTokens).toBe(30_000);
  });

  it('carries the wall-clock time of the reading that closed the turn', () => {
    const messages = [
      assistant(100_000, '2026-07-30T10:00:00Z'),
      prompt('p1'),
      assistant(130_000, '2026-07-30T10:05:00Z'),
    ];
    expect(turnDeltaSeries(messages)[0].at).toBe(Date.parse('2026-07-30T10:05:00Z'));
  });
});

describe('turnDeltaSeries — subagent isolation', () => {
  it('does not let a subagent message close a turn', () => {
    const msgs = [assistant(100_000), prompt('p1'), assistant(160_000), sidechain(900_000)];
    expect(turnDeltaSeries(msgs)[0].newTotal).toBe(160_000);
  });

  it('does not let a subagent message become the baseline', () => {
    const msgs = [assistant(100_000), sidechain(900_000), prompt('p1'), assistant(160_000)];
    expect(turnDeltaSeries(msgs)[0]).toMatchObject({ prevTotal: 100_000, deltaTokens: 60_000 });
  });
});

// Compact summaries used to classify as 'prompt', which made the summary the
// turn anchor and reported the entire rebuilt context as a jump every time.
describe('turnDeltaSeries — compact summaries are not prompts', () => {
  it('anchors on the human prompt, not the summary that follows a compaction', () => {
    const msgs = [
      assistant(500_000),
      compactBoundary(),
      compactSummary(),
      assistant(80_000),
      prompt('p9'),
      assistant(140_000),
    ];

    const series = turnDeltaSeries(msgs);
    expect(series.map((e) => e.anchorId)).toEqual(['p9']);
    expect(series[0]).toMatchObject({ prevTotal: 80_000, newTotal: 140_000, deltaTokens: 60_000 });
  });

  it('yields no turn when the only user record since the drop is the summary', () => {
    const msgs = [assistant(500_000), compactBoundary(), compactSummary(), assistant(80_000)];
    expect(turnDeltaSeries(msgs)).toEqual([]);
  });
});

describe('turnDeltaSeries — the jump threshold', () => {
  // The threshold no longer gates whether anything is reported; it decides
  // whether a row is coloured as a jump. DEFAULT_CONTEXT_JUMP_TOKENS is still
  // the number, and still 50k.
  it('defaults to 50k', () => {
    expect(DEFAULT_CONTEXT_JUMP_TOKENS).toBe(50_000);
  });

  it('reports turns on both sides of it, unlike the banner it replaced', () => {
    const below = [assistant(100_000), prompt('p1'), assistant(149_999)];
    const at = [assistant(100_000), prompt('p1'), assistant(150_000)];

    expect(turnDeltaSeries(below)[0].deltaTokens).toBe(49_999);
    expect(turnDeltaSeries(at)[0].deltaTokens).toBe(50_000);
  });

  it('keeps a turn delta whole across its tool loop', () => {
    const msgs = [assistant(100_000), prompt('p1'), assistant(425_000), toolResult(), assistant(427_000)];
    expect(turnDeltaSeries(msgs)[0].deltaTokens).toBe(327_000);
  });
});
