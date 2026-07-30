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

const user = (): JsonlNode =>
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

describe('turnContextTotal', () => {
  it('sums input + cache_read + cache_creation + output', () => {
    expect(turnContextTotal(assistant(477_456))).toBe(477_456);
  });

  it('is null for a turn with no usage', () => {
    expect(turnContextTotal(user())).toBeNull();
  });
});

describe('lastTurnDelta', () => {
  it('reports the growth between the last two assistant turns', () => {
    const msgs = [assistant(477_456), user(), assistant(802_456)];
    expect(lastTurnDelta(msgs)).toEqual({
      deltaTokens: 325_000,
      prevTotal: 477_456,
      newTotal: 802_456,
    });
  });

  it('is null with only one turn to go on', () => {
    expect(lastTurnDelta([assistant(43_000)])).toBeNull();
    expect(lastTurnDelta([])).toBeNull();
  });

  // A compaction drops context by design. Differencing across it reports a
  // huge negative "jump" that means the opposite of a problem.
  it('is null across a compact boundary', () => {
    const msgs = [assistant(802_456), compactBoundary(), assistant(60_000)];
    expect(lastTurnDelta(msgs)).toBeNull();
  });

  it('is null when context shrank without a compaction', () => {
    const msgs = [assistant(300_000), assistant(280_000)];
    expect(lastTurnDelta(msgs)).toBeNull();
  });

  it('ignores non-assistant nodes between the turns', () => {
    const msgs = [assistant(100_000), user(), user(), assistant(160_000)];
    expect(lastTurnDelta(msgs)?.deltaTokens).toBe(60_000);
  });
});

describe('evaluateContextJump', () => {
  const setting = { enabled: true, thresholdTokens: DEFAULT_CONTEXT_JUMP_TOKENS };

  it('defaults to a 50k threshold', () => {
    expect(DEFAULT_CONTEXT_JUMP_TOKENS).toBe(50_000);
  });

  it('fires on a jump at or above the threshold', () => {
    const msgs = [assistant(100_000), assistant(150_000)];
    expect(evaluateContextJump({ messages: msgs, setting })).toEqual({
      deltaTokens: 50_000,
      prevTotal: 100_000,
      newTotal: 150_000,
    });
  });

  it('stays quiet just below the threshold', () => {
    const msgs = [assistant(100_000), assistant(149_999)];
    expect(evaluateContextJump({ messages: msgs, setting })).toBeNull();
  });

  it('stays quiet when disabled', () => {
    const msgs = [assistant(100_000), assistant(500_000)];
    expect(
      evaluateContextJump({ messages: msgs, setting: { ...setting, enabled: false } }),
    ).toBeNull();
  });

  // Reporting only the most recent delta is what makes the notice self-clear:
  // the big turn scrolls out of "most recent" as soon as a normal one lands.
  it('clears once a later, smaller turn lands', () => {
    const jumped = [assistant(100_000), assistant(425_000)];
    expect(evaluateContextJump({ messages: jumped, setting })).not.toBeNull();
    const settled = [...jumped, assistant(427_000)];
    expect(evaluateContextJump({ messages: settled, setting })).toBeNull();
  });
});
