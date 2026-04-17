import { describe, it, expect } from 'vitest';
import { synthesizeResultMessages } from '../synthesizeResults';

function userMsg(ts: string) {
  return { type: 'user' as const, timestamp: ts, message: { content: [{ type: 'text', text: 'hi' }] } };
}

function assistantMsg(ts: string, text: string, opts: { stop_reason?: string; tokens?: { in: number; out: number } } = {}) {
  return {
    type: 'assistant' as const,
    timestamp: ts,
    message: {
      content: [{ type: 'text', text }],
      stop_reason: opts.stop_reason ?? 'end_turn',
      usage: {
        input_tokens: opts.tokens?.in ?? 100,
        output_tokens: opts.tokens?.out ?? 50,
      },
    },
  };
}

describe('synthesizeResultMessages', () => {
  it('returns input unchanged when a real result is already present', () => {
    const input = [
      userMsg('2026-04-17T15:00:00Z'),
      assistantMsg('2026-04-17T15:00:01Z', 'hello'),
      { type: 'result' as const, subtype: 'success', result: 'hello' } as any,
    ];
    expect(synthesizeResultMessages(input as any)).toBe(input);
  });

  it('injects a synthetic result after each completed turn', () => {
    const input = [
      userMsg('2026-04-17T15:00:00Z'),
      assistantMsg('2026-04-17T15:00:01Z', 'first'),
      userMsg('2026-04-17T15:01:00Z'),
      assistantMsg('2026-04-17T15:01:03Z', 'second'),
    ];
    const out = synthesizeResultMessages(input as any) as any[];
    expect(out).toHaveLength(6);
    expect(out[0].type).toBe('user');
    expect(out[1].type).toBe('assistant');
    expect(out[2].type).toBe('result');
    expect(out[2].subtype).toBe('success');
    expect(out[2].result).toBe('first');
    expect(out[2].num_turns).toBe(1);
    expect(out[2].duration_ms).toBe(1000);
    expect(out[3].type).toBe('user');
    expect(out[4].type).toBe('assistant');
    expect(out[5].type).toBe('result');
    expect(out[5].result).toBe('second');
    expect(out[5].num_turns).toBe(2);
    expect(out[5].duration_ms).toBe(3000);
  });

  it('skips mid-turn tool_use assistant messages when picking the turn ender', () => {
    // Simulates a real turn: user → assistant(tool_use) → tool_result user
    // → assistant(end_turn). Only the final assistant should drive the
    // synthesized result; the mid-turn tool_use step must be ignored.
    const toolUserReply = {
      type: 'user' as const,
      timestamp: '2026-04-17T15:00:02Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    };
    const input = [
      userMsg('2026-04-17T15:00:00Z'),
      assistantMsg('2026-04-17T15:00:01Z', '', { stop_reason: 'tool_use' }),
      toolUserReply,
      assistantMsg('2026-04-17T15:00:05Z', 'final answer'),
    ];
    const out = synthesizeResultMessages(input as any) as any[];
    const results = out.filter((m) => m.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe('success');
    expect(results[0].result).toBe('final answer');
    expect(results[0].duration_ms).toBe(5000);
  });

  it('emits no synthetic result for an incomplete turn (no end_turn reached)', () => {
    const input = [
      userMsg('2026-04-17T15:00:00Z'),
      assistantMsg('2026-04-17T15:00:01Z', 'truncated', { stop_reason: 'max_tokens' }),
    ];
    const out = synthesizeResultMessages(input as any) as any[];
    const results = out.filter((m) => m.type === 'result');
    expect(results).toHaveLength(0);
  });

  it('copies usage and computes total_cost_usd from rates', () => {
    const input = [
      userMsg('2026-04-17T15:00:00Z'),
      assistantMsg('2026-04-17T15:00:01Z', 'x', { tokens: { in: 1_000_000, out: 1_000_000 } }),
    ];
    const out = synthesizeResultMessages(input as any) as any[];
    expect(out[2].usage.input_tokens).toBe(1_000_000);
    expect(out[2].usage.output_tokens).toBe(1_000_000);
    // 1M input * $3 + 1M output * $15 = $18
    expect(out[2].total_cost_usd).toBeCloseTo(18, 2);
  });
});
