import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import {
  DEFAULT_CONTEXT_JUMP_TOKENS,
  turnContextTotal,
  lastTurnDelta,
  evaluateContextJump,
} from '../turnDelta';

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

describe('lastTurnDelta — subagent isolation', () => {
  it('does not let a subagent message become the current total', () => {
    const msgs = [assistant(100_000), prompt(), assistant(160_000), sidechain(900_000)];
    expect(lastTurnDelta(msgs)?.newTotal).toBe(160_000);
  });

  it('does not let a subagent message become the baseline', () => {
    const msgs = [assistant(100_000), sidechain(900_000), prompt(), assistant(160_000)];
    expect(lastTurnDelta(msgs)).toMatchObject({ prevTotal: 100_000, deltaTokens: 60_000 });
  });
});

describe('lastTurnDelta', () => {
  it('measures growth since the last prompt the human typed', () => {
    const msgs = [assistant(477_456), prompt(), assistant(802_456)];
    expect(lastTurnDelta(msgs)).toEqual({
      deltaTokens: 325_000,
      prevTotal: 477_456,
      newTotal: 802_456,
      anchorId: 'p1',
    });
  });

  // The regression this rewrite exists for. Measured from session
  // 856ad35e: a skill load added 324,691 tokens mid-turn, and the tool loop
  // kept going. Differencing the two most recent ASSISTANT messages reported
  // the trailing +1,394 and the notice vanished seconds after it appeared.
  it('holds the jump for the rest of a tool-looping turn', () => {
    const msgs = [
      assistant(64_843),
      prompt(),
      assistant(389_534), // the skill body lands
      toolResult(),
      assistant(390_928), // ordinary follow-up steps
      toolResult(),
      assistant(391_000),
    ];
    expect(lastTurnDelta(msgs)?.deltaTokens).toBe(326_157);
  });

  it('re-anchors on the next prompt', () => {
    const msgs = [
      assistant(64_843),
      prompt('p1'),
      assistant(389_534),
      prompt('p2'),
      assistant(391_000),
    ];
    expect(lastTurnDelta(msgs)).toMatchObject({
      deltaTokens: 1_466,
      prevTotal: 389_534,
      anchorId: 'p2',
    });
  });

  it('is null before the turn has produced any usage', () => {
    expect(lastTurnDelta([assistant(43_000), prompt()])).toBeNull();
  });

  it('is null with no baseline before the prompt', () => {
    // A session's very first prompt has nothing to difference against.
    expect(lastTurnDelta([prompt(), assistant(220_000)])).toBeNull();
  });

  it('is null with no prompt to anchor to', () => {
    expect(lastTurnDelta([assistant(100_000), assistant(400_000)])).toBeNull();
    expect(lastTurnDelta([])).toBeNull();
  });

  // A compaction drops context by design. Differencing across it reports a
  // huge negative "jump" that means the opposite of a problem.
  it('is null across a compact boundary', () => {
    const msgs = [assistant(802_456), compactBoundary(), prompt(), assistant(60_000)];
    expect(lastTurnDelta(msgs)).toBeNull();
  });

  it('is null when context shrank without a compaction', () => {
    expect(lastTurnDelta([assistant(300_000), prompt(), assistant(280_000)])).toBeNull();
  });

  it('does not treat a tool_result as a turn boundary', () => {
    const msgs = [assistant(100_000), prompt(), toolResult(), assistant(160_000)];
    expect(lastTurnDelta(msgs)?.deltaTokens).toBe(60_000);
  });
});

describe('evaluateContextJump', () => {
  const setting = { enabled: true, thresholdTokens: DEFAULT_CONTEXT_JUMP_TOKENS };

  it('defaults to a 50k threshold', () => {
    expect(DEFAULT_CONTEXT_JUMP_TOKENS).toBe(50_000);
  });

  it('fires on a jump at or above the threshold', () => {
    const msgs = [assistant(100_000), prompt(), assistant(150_000)];
    expect(evaluateContextJump({ messages: msgs, setting })).toMatchObject({
      deltaTokens: 50_000,
      prevTotal: 100_000,
      newTotal: 150_000,
    });
  });

  it('stays quiet just below the threshold', () => {
    const msgs = [assistant(100_000), prompt(), assistant(149_999)];
    expect(evaluateContextJump({ messages: msgs, setting })).toBeNull();
  });

  it('stays quiet when disabled', () => {
    const msgs = [assistant(100_000), prompt(), assistant(500_000)];
    expect(
      evaluateContextJump({ messages: msgs, setting: { ...setting, enabled: false } }),
    ).toBeNull();
  });

  // The notice now survives its whole turn and clears when the human moves on,
  // rather than being wiped by the next tool-loop step.
  it('persists through the turn and clears on the next prompt', () => {
    const jumped = [assistant(100_000), prompt('p1'), assistant(425_000)];
    expect(evaluateContextJump({ messages: jumped, setting })).not.toBeNull();

    const stillRunning = [...jumped, toolResult(), assistant(427_000)];
    expect(evaluateContextJump({ messages: stillRunning, setting })).not.toBeNull();

    const nextTurn = [...stillRunning, prompt('p2'), assistant(428_000)];
    expect(evaluateContextJump({ messages: nextTurn, setting })).toBeNull();
  });
});
