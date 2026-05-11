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

  it('emits a synthetic error result for a max_tokens terminal stop', () => {
    // max_tokens IS a terminal stop — the assistant has nothing more to
    // say on this turn, the output was just truncated at the per-response
    // ceiling. Before this change the result card silently disappeared
    // for these turns on reload; users saw the cut-off assistant message
    // and then nothing, with no indication that the model had stopped.
    const input = [
      userMsg('2026-04-17T15:00:00Z'),
      assistantMsg('2026-04-17T15:00:01Z', 'truncated', { stop_reason: 'max_tokens' }),
    ];
    const out = synthesizeResultMessages(input as any) as any[];
    const results = out.filter((m) => m.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe('error_during_execution');
    expect(results[0].is_error).toBe(true);
    expect(results[0].stop_reason).toBe('max_tokens');
    expect(results[0].result).toBe('truncated');
  });

  it('emits a synthetic error result for a refusal terminal stop', () => {
    const input = [
      userMsg('2026-04-17T15:00:00Z'),
      assistantMsg('2026-04-17T15:00:01Z', "I can't help with that.", { stop_reason: 'refusal' }),
    ];
    const out = synthesizeResultMessages(input as any) as any[];
    const results = out.filter((m) => m.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].stop_reason).toBe('refusal');
    expect(results[0].result).toBe("I can't help with that.");
  });

  it('emits a synthetic error result for a model_context_window_exceeded terminal stop', () => {
    const input = [
      userMsg('2026-04-17T15:00:00Z'),
      assistantMsg('2026-04-17T15:00:01Z', '', {
        stop_reason: 'model_context_window_exceeded',
      }),
    ];
    const out = synthesizeResultMessages(input as any) as any[];
    const results = out.filter((m) => m.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBe(true);
    expect(results[0].stop_reason).toBe('model_context_window_exceeded');
  });

  it('emits a synthetic success result for a stop_sequence terminal stop', () => {
    // stop_sequence is terminal but not an error — the model hit a custom
    // stop sentinel and stopped exactly where it was supposed to.
    const input = [
      userMsg('2026-04-17T15:00:00Z'),
      assistantMsg('2026-04-17T15:00:01Z', 'done', { stop_reason: 'stop_sequence' }),
    ];
    const out = synthesizeResultMessages(input as any) as any[];
    const results = out.filter((m) => m.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe('success');
    expect(results[0].is_error).toBe(false);
    expect(results[0].stop_reason).toBe('stop_sequence');
  });

  it('does NOT emit a result when the turn ends on a non-terminal stop (e.g. tool_use awaiting a tool_result that never arrives)', () => {
    // The legitimate "no result" case: assistant emitted `tool_use` but
    // the transcript ends before the tool_result + next assistant step.
    // The turn is genuinely incomplete — no terminal stop reason was
    // reached — so no synthetic result is appropriate.
    const input = [
      userMsg('2026-04-17T15:00:00Z'),
      assistantMsg('2026-04-17T15:00:01Z', '', { stop_reason: 'tool_use' }),
    ];
    const out = synthesizeResultMessages(input as any) as any[];
    const results = out.filter((m) => m.type === 'result');
    expect(results).toHaveLength(0);
  });

  it('does NOT emit a result for an assistant message with no stop_reason at all', () => {
    // Partial / interrupted assistant messages: never reached a stop.
    const partialAssistant = {
      type: 'assistant' as const,
      timestamp: '2026-04-17T15:00:01Z',
      message: {
        content: [{ type: 'text', text: 'partial' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    const input = [userMsg('2026-04-17T15:00:00Z'), partialAssistant];
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
