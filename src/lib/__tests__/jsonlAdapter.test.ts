import { describe, it, expect } from 'vitest';
import { jsonlNodeToStreamMessage } from '../jsonlAdapter';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import type { JsonlNode } from '@/types/jsonl';

describe('jsonlNodeToStreamMessage', () => {
  it('passes through an assistant node as its raw shape', () => {
    const node: JsonlNode = {
      kind: 'assistant',
      raw: {
        type: 'assistant',
        sessionId: 'sid',
        timestamp: 'ts',
        message: { role: 'assistant', content: [], stop_reason: 'end_turn' },
      } as any,
      sessionId: 'sid',
      receivedAt: 'ts',
    };
    const msg = jsonlNodeToStreamMessage(node);
    expect(msg?.type).toBe('assistant');
    expect((msg as any).receivedAt).toBe('ts');
  });

  it('returns null for overlay kinds (they do not enter messages[])', () => {
    expect(jsonlNodeToStreamMessage({ kind: 'stream-event', uuid: 'u', deltaText: 'x' })).toBeNull();
    expect(jsonlNodeToStreamMessage({ kind: 'rate-limit', info: { status: 'allowed' } })).toBeNull();
    expect(jsonlNodeToStreamMessage({ kind: 'lifecycle', eventType: 'status', raw: {} })).toBeNull();
  });

  it('returns the raw node for purely bookkeeping kinds', () => {
    const node: JsonlNode = {
      kind: 'last-prompt',
      raw: { type: 'last-prompt', lastPrompt: 'x', leafUuid: 'u', sessionId: 'sid' } as any,
      sessionId: 'sid',
    };
    const msg = jsonlNodeToStreamMessage(node);
    expect(msg?.type).toBe('last-prompt');
  });
});

describe('jsonlNodeToStreamMessage — streamKind', () => {
  it('sets streamKind on adapted messages', () => {
    const node = classifyJsonlLine({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-05-26T00:00:00.000Z',
      isMeta: true,
      sourceToolUseID: 'toolu_x',
      message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x' }] },
    });
    expect(node).not.toBeNull();
    const msg = jsonlNodeToStreamMessage(node!);
    expect(msg?.streamKind).toBe('user.meta.skill');
  });

  it('sets streamKind = "unknown" for an unknown classification', () => {
    const node = classifyJsonlLine({ type: 'mystery', timestamp: '2026-05-26T00:00:00.000Z' });
    expect(node?.kind).toBe('unknown');
    const msg = jsonlNodeToStreamMessage(node!);
    expect(msg?.streamKind).toBe('unknown');
  });
});
