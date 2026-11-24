import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { buildContextTimeline, showsGutterDelta } from '../contextTimeline';
import { DEFAULT_CONTEXT_PRESSURE } from '../contextPressure';

const LIMIT = 1_000_000;
// Default budget is an absolute 250k, so warn lands at 200k and critical at 250k.
const opts = {
  limit: LIMIT,
  jumpThresholdTokens: 50_000,
  pressure: DEFAULT_CONTEXT_PRESSURE,
};

const assistant = (total: number, content: unknown[] = [{ type: 'text', text: 'Done.' }]): JsonlNode =>
  ({
    kind: 'assistant',
    sessionId: 's1',
    receivedAt: '2026-07-30T10:00:00Z',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content,
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: total - 3,
          cache_creation_input_tokens: 1,
          output_tokens: 1,
        },
      },
    },
  }) as unknown as JsonlNode;

const toolCall = (total: number): JsonlNode =>
  assistant(total, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]);

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

describe('buildContextTimeline — badges only on replies', () => {
  it('gives a tool call no badge', () => {
    const tool = toolCall(120_000);
    const t = buildContextTimeline([assistant(100_000), tool], opts);
    expect(t.get(tool)?.isSample).toBe(false);
  });

  it('carries the latest reading on a tool row, so the line follows real context', () => {
    const tool = toolCall(230_000);
    const t = buildContextTimeline([assistant(100_000), tool], opts);
    expect(t.get(tool)?.tokens).toBe(230_000);
    expect(t.get(tool)?.level).toBe('warn');
  });

  it('measures a reply against the previous reply, counting the tool work between', () => {
    const reply = assistant(160_000);
    const t = buildContextTimeline(
      [assistant(100_000), toolCall(120_000), toolCall(150_000), reply],
      opts,
    );
    expect(t.get(reply)).toMatchObject({ isSample: true, tokens: 160_000, delta: 60_000, prevTokens: 100_000, isJump: true });
  });

  it('gives no badge to a message with only thinking in it', () => {
    const thinking = assistant(110_000, [{ type: 'thinking', thinking: 'hmm' }]);
    const t = buildContextTimeline([assistant(100_000), thinking], opts);
    expect(t.get(thinking)?.isSample).toBe(false);
  });

  it('gives no badge to whitespace-only text', () => {
    const blank = assistant(110_000, [{ type: 'text', text: '  \n' }]);
    const t = buildContextTimeline([assistant(100_000), blank], opts);
    expect(t.get(blank)?.isSample).toBe(false);
  });

  it('badges a message that says something and calls a tool', () => {
    const both = assistant(110_000, [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    ]);
    const t = buildContextTimeline([assistant(100_000), both], opts);
    expect(t.get(both)).toMatchObject({ isSample: true, delta: 10_000 });
  });

  it('marks the first reply after a compaction as the reset, even with tool work before it', () => {
    const reply = assistant(40_000);
    const t = buildContextTimeline(
      [assistant(300_000), compactBoundary(), toolCall(30_000), reply],
      opts,
    );
    expect(t.get(reply)).toMatchObject({ isSample: true, isReset: true, delta: null, prevTokens: 300_000 });
  });

  it('starts the series at the first reply, measured from nothing', () => {
    const reply = assistant(50_000);
    const t = buildContextTimeline([prompt(), toolCall(30_000), reply], opts);
    expect(t.get(reply)).toMatchObject({ isSample: true, delta: null, prevTokens: null });
  });
});

describe('buildContextTimeline — filtered rendering', () => {
  // ClaudeTranscript renders `displayableMessages` (hard-filtered), not
  // `messages`.
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

describe('buildContextTimeline — pressure level', () => {
  const at = (tokens: number) => {
    const node = assistant(tokens);
    return buildContextTimeline([node], opts).get(node);
  };

  it('is none well below the budget', () => {
    expect(at(50_000)?.level).toBe('none');
  });

  it('is warn at 80% of the budget', () => {
    expect(at(200_000)?.level).toBe('warn');
  });

  it('is critical at the budget', () => {
    expect(at(250_000)?.level).toBe('critical');
  });

  it('carries the level forward on rows with no reading', () => {
    const a = assistant(250_000);
    const p = prompt();
    const t = buildContextTimeline([a, p], opts);
    expect(t.get(p)?.isSample).toBe(false);
    expect(t.get(p)?.level).toBe('critical');
  });

  it('drops the level after a compaction resets the window', () => {
    const before = assistant(250_000);
    const after = assistant(20_000);
    const t = buildContextTimeline([before, compactBoundary(), after], opts);
    expect(t.get(before)?.level).toBe('critical');
    expect(t.get(after)?.level).toBe('none');
  });
});

describe('buildContextTimeline — previous reading', () => {
  it('carries the previous sample so a row can show its own delta', () => {
    const messages = [assistant(100_000), assistant(180_000)];
    const points = buildContextTimeline(messages, opts);

    expect(points.get(messages[0])?.prevTokens).toBeNull();
    expect(points.get(messages[1])?.prevTokens).toBe(100_000);
  });

  it('carries it across a compaction, where `delta` is deliberately null', () => {
    const messages = [assistant(500_000), compactBoundary(), assistant(80_000)];
    const points = buildContextTimeline(messages, opts);

    const reset = points.get(messages[2]);
    expect(reset?.isReset).toBe(true);
    expect(reset?.delta).toBeNull();
    expect(reset?.prevTokens).toBe(500_000);
  });
});

describe('showsGutterDelta', () => {
  it('prints every non-zero delta in Expanded', () => {
    expect(showsGutterDelta(120, 'expanded')).toBe(true);
    expect(showsGutterDelta(-120, 'expanded')).toBe(true);
  });

  it('hides sub-2k noise in Standard, by magnitude not sign', () => {
    expect(showsGutterDelta(1_999, 'standard')).toBe(false);
    expect(showsGutterDelta(-1_999, 'standard')).toBe(false);
    expect(showsGutterDelta(2_000, 'standard')).toBe(true);
    expect(showsGutterDelta(-2_000, 'standard')).toBe(true);
  });

  it('has nothing to print with no reading or no movement', () => {
    expect(showsGutterDelta(null, 'expanded')).toBe(false);
    expect(showsGutterDelta(0, 'expanded')).toBe(false);
  });
});

describe('buildContextTimeline — the reply the CLI re-writes after /compact', () => {
  // The CLI copies the last reply in after the compact_boundary with all-zero
  // usage.
  const zeroCopy = (): JsonlNode => {
    const node = assistant(100_000) as unknown as { raw: { message: { usage: Record<string, number> } } };
    node.raw.message.usage = {
      input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
    };
    return node as unknown as JsonlNode;
  };

  it('badges neither the copy nor anything before the boundary as a drop', () => {
    const before = assistant(421_000);
    const copy = zeroCopy();
    const after = assistant(79_000);
    const t = buildContextTimeline([before, prompt(), compactBoundary(), copy, prompt(), after], opts);
    expect(t.get(before)).toMatchObject({ tokens: 421_000, isSample: true, isReset: false });
    expect(t.get(copy)).toMatchObject({ tokens: 421_000, isSample: false });
    expect(t.get(after)).toMatchObject({
      tokens: 79_000, isSample: true, isReset: true, prevTokens: 421_000, delta: null,
    });
  });
});
