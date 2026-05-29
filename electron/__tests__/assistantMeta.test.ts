import { describe, it, expect } from 'vitest';
import {
  readMessageDeltaMeta,
  applyAssistantMeta,
  deltaStashKey,
  createAssistantResolver,
  type AssistantMeta,
} from '../services/agents/assistantMeta';

describe('readMessageDeltaMeta', () => {
  it('extracts stop_reason + usage from a message_delta stream_event', () => {
    const payload = {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1234 },
      },
    };
    expect(readMessageDeltaMeta(payload)).toEqual({
      stopReason: 'end_turn',
      usage: { output_tokens: 1234 },
    });
  });

  it('returns null for non-message_delta stream_events (e.g. text deltas)', () => {
    const payload = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    };
    expect(readMessageDeltaMeta(payload)).toBeNull();
  });

  it('returns null for non-stream_event payloads', () => {
    expect(readMessageDeltaMeta({ type: 'assistant', message: {} })).toBeNull();
    expect(readMessageDeltaMeta(null)).toBeNull();
    expect(readMessageDeltaMeta('nope')).toBeNull();
  });
});

describe('deltaStashKey', () => {
  it('keys by parent_tool_use_id so subagent and main streams do not cross-merge', () => {
    expect(deltaStashKey({ parent_tool_use_id: 'toolu_9' })).toBe('toolu_9');
  });
  it('falls back to a stable main-chain key when parent_tool_use_id is absent/null', () => {
    expect(deltaStashKey({ parent_tool_use_id: null })).toBe(deltaStashKey({}));
    expect(deltaStashKey({})).toBe('__main__');
  });
});

describe('applyAssistantMeta', () => {
  const meta: AssistantMeta = { stopReason: 'end_turn', usage: { output_tokens: 1234 } };

  it('fills stop_reason and merges usage when the committed assistant has stop_reason:null', () => {
    const payload = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: null,
        usage: { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 99 },
      },
    };
    const out = applyAssistantMeta(payload, meta) as typeof payload;
    expect(out.message.stop_reason).toBe('end_turn');
    // delta usage wins for output_tokens; pre-existing fields are preserved
    expect(out.message.usage).toMatchObject({
      input_tokens: 2,
      output_tokens: 1234,
      cache_read_input_tokens: 99,
    });
  });

  it('does NOT overwrite a stop_reason the committed frame already resolved', () => {
    const payload = {
      type: 'assistant',
      message: { role: 'assistant', content: [], stop_reason: 'tool_use', usage: { output_tokens: 50 } },
    };
    const out = applyAssistantMeta(payload, meta) as typeof payload;
    expect(out.message.stop_reason).toBe('tool_use');
    expect(out.message.usage).toEqual({ output_tokens: 50 });
  });

  it('is a no-op for non-assistant payloads', () => {
    const payload = { type: 'user', message: { role: 'user', content: [] } };
    expect(applyAssistantMeta(payload, meta)).toBe(payload);
  });
});

describe('createAssistantResolver', () => {
  // Frame factories mirroring the real --include-partial-messages stream order:
  // message_start → (content) → committed assistant → content_block_stop →
  // message_delta (resolved stop_reason/usage) → message_stop.
  const start = (id: string, parent: string | null = null) =>
    ({ type: 'stream_event', event: { type: 'message_start', message: { id, stop_reason: null } }, parent_tool_use_id: parent });
  const committed = (id: string, parent: string | null = null, stop: string | null = null, out = 4) =>
    ({ type: 'assistant', message: { id, stop_reason: stop, usage: { output_tokens: out } }, parent_tool_use_id: parent });
  const cbDelta = (parent: string | null = null) =>
    ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }, parent_tool_use_id: parent });
  const delta = (stop: string, out = 88, parent: string | null = null) =>
    ({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: out } }, parent_tool_use_id: parent });
  const stop = (parent: string | null = null) =>
    ({ type: 'stream_event', event: { type: 'message_stop' }, parent_tool_use_id: parent });
  const toolResult = () => ({ type: 'user', message: { role: 'user', content: [] } });
  const result = (stop_reason = 'end_turn') => ({ type: 'result', subtype: 'success', stop_reason });

  type Asst = { type: string; message: { id?: string; stop_reason?: string | null; usage?: { output_tokens?: number } } };
  const run = (frames: unknown[]): unknown[] => {
    const r = createAssistantResolver();
    const out: unknown[] = [];
    for (const f of frames) out.push(...r.resolve(f));
    return out;
  };
  const assistants = (out: unknown[]): Asst[] =>
    out.filter((f) => (f as { type?: string }).type === 'assistant') as Asst[];

  it('merges the resolved stop_reason + final usage into the committed assistant, emitted once', () => {
    const out = run([start('A'), committed('A'), cbDelta(), delta('end_turn', 88), stop()]);
    const a = assistants(out);
    expect(a).toHaveLength(1);
    expect(a[0].message.stop_reason).toBe('end_turn');
    expect(a[0].message.usage?.output_tokens).toBe(88);
  });

  it('emits the committed assistant only after its message_delta has resolved it', () => {
    const out = run([start('A'), committed('A'), delta('end_turn'), stop()]);
    const deltaIdx = out.findIndex((f) => (f as { event?: { type?: string } }).event?.type === 'message_delta');
    const asstIdx = out.findIndex((f) => (f as { type?: string }).type === 'assistant');
    expect(asstIdx).toBeGreaterThan(deltaIdx);
  });

  it('resolves two messages in a turn without off-by-one (tool_use then end_turn)', () => {
    const out = run([
      start('A'), committed('A'), delta('tool_use', 10), stop(), toolResult(),
      start('B'), committed('B'), delta('end_turn', 88), stop(), result(),
    ]);
    const a = assistants(out);
    expect(a).toHaveLength(2);
    expect(a[0].message.stop_reason).toBe('tool_use');
    expect(a[1].message.stop_reason).toBe('end_turn');
  });

  it('still merges when the delta arrives before the committed assistant (reversed order)', () => {
    const out = run([start('A'), delta('end_turn'), committed('A'), stop()]);
    const a = assistants(out);
    expect(a).toHaveLength(1);
    expect(a[0].message.stop_reason).toBe('end_turn');
  });

  it('forwards a delta-less message unchanged at message_stop (fail-safe, never drops)', () => {
    const out = run([start('A'), committed('A'), stop()]);
    const a = assistants(out);
    expect(a).toHaveLength(1);
    expect(a[0].message.stop_reason).toBeNull();
  });

  it('flushes a buffered assistant when a result ends the turn with no message_stop', () => {
    const out = run([start('A'), committed('A'), result()]);
    const a = assistants(out);
    expect(a).toHaveLength(1);
    const asstIdx = out.findIndex((f) => (f as { type?: string }).type === 'assistant');
    const resultIdx = out.findIndex((f) => (f as { type?: string }).type === 'result');
    expect(asstIdx).toBeGreaterThanOrEqual(0);
    expect(asstIdx).toBeLessThan(resultIdx);
  });

  it('keeps subagent and main chains separate (a subagent delta never resolves a main-chain assistant)', () => {
    const out = run([
      start('A'), committed('A'),               // main message open, buffered
      start('S', 't1'), committed('S', 't1'),   // subagent message open, buffered
      delta('end_turn', 88, 't1'), stop('t1'),  // resolves S only
      delta('tool_use', 10), stop(),            // resolves A only
    ]);
    const a = assistants(out);
    const A = a.find((f) => f.message.id === 'A');
    const S = a.find((f) => f.message.id === 'S');
    expect(A?.message.stop_reason).toBe('tool_use');
    expect(S?.message.stop_reason).toBe('end_turn');
  });

  it('passes content_block deltas through without disturbing the buffered assistant', () => {
    const out = run([start('A'), committed('A'), cbDelta(), cbDelta(), delta('end_turn'), stop()]);
    expect(out.filter((f) => (f as { event?: { type?: string } }).event?.type === 'content_block_delta')).toHaveLength(2);
    expect(assistants(out)[0].message.stop_reason).toBe('end_turn');
  });
});
