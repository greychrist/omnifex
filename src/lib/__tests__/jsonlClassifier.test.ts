import { describe, it, expect } from 'vitest';
import { classifyJsonlLine } from '../jsonlClassifier';
import { JSONL_SAMPLES } from './fixtures/jsonl-samples';

describe('classifyJsonlLine', () => {
  it('classifies assistant lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['assistant']);
    expect(node?.kind).toBe('assistant');
    if (node?.kind === 'assistant') {
      expect(node.sessionId).toBeTruthy();
      expect(node.receivedAt).toBeTruthy();
      expect(node.raw.message.role).toBe('assistant');
    }
  });

  it('classifies a user prompt as userKind=prompt', () => {
    const sample = {
      type: 'user',
      sessionId: 'sid-1',
      timestamp: '2026-05-23T20:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') {
      expect(node.userKind).toBe('prompt');
    }
  });

  it('classifies a tool_result reply as userKind=tool-result', () => {
    const sample = {
      type: 'user',
      sessionId: 'sid-1',
      timestamp: '2026-05-23T20:00:01Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }],
      },
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') {
      expect(node.userKind).toBe('tool-result');
    }
  });

  it('classifies attachment lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['attachment']);
    expect(node?.kind).toBe('attachment');
  });

  it('classifies queue-operation lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['queue-operation']);
    expect(node?.kind).toBe('queue-operation');
  });

  it('returns null for malformed input', () => {
    expect(classifyJsonlLine(null)).toBeNull();
    expect(classifyJsonlLine(undefined)).toBeNull();
    expect(classifyJsonlLine('not an object')).toBeNull();
    expect(classifyJsonlLine({})).toBeNull();
    expect(classifyJsonlLine({ type: 'unknown-future-type' })).toBeNull();
  });

  it('uses receivedAt fallback when timestamp is missing', () => {
    const sample = {
      type: 'assistant',
      sessionId: 'sid-2',
      message: { role: 'assistant', content: [] },
    };
    const before = Date.now();
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('assistant');
    if (node?.kind === 'assistant') {
      const stamp = Date.parse(node.receivedAt);
      expect(stamp).toBeGreaterThanOrEqual(before);
    }
  });
});
