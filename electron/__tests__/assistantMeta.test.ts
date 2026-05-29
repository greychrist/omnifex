import { describe, it, expect } from 'vitest';
import {
  readMessageDeltaMeta,
  applyAssistantMeta,
  deltaStashKey,
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
