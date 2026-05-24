import { describe, it, expect } from 'vitest';
import { jsonlNodeToStreamMessage } from '../jsonlAdapter';
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

  it('converts synthesized-init to system/init shape', () => {
    const node: JsonlNode = {
      kind: 'synthesized-init',
      sessionId: 'sid-xyz',
      cwd: '/p',
      receivedAt: 'ts-init',
    };
    const msg = jsonlNodeToStreamMessage(node);
    expect(msg?.type).toBe('system');
    expect((msg as any).subtype).toBe('init');
    expect((msg as any).session_id).toBe('sid-xyz');
    expect((msg as any).cwd).toBe('/p');
    expect((msg as any).receivedAt).toBe('ts-init');
  });

  it('converts synthesized-result to result shape with synthesized:true', () => {
    const node: JsonlNode = {
      kind: 'synthesized-result',
      sessionId: 'sid',
      isError: false,
      subtype: 'success',
      body: 'done',
      durationMs: 1234,
      usage: { input_tokens: 10, output_tokens: 20 } as any,
      totalCostUsd: 0.001,
      stopReason: 'end_turn',
      receivedAt: 'ts-r',
    };
    const msg = jsonlNodeToStreamMessage(node);
    expect(msg?.type).toBe('result');
    expect((msg as any).subtype).toBe('success');
    expect((msg as any).is_error).toBe(false);
    expect((msg as any).result).toBe('done');
    expect((msg as any).duration_ms).toBe(1234);
    expect((msg as any).total_cost_usd).toBe(0.001);
    expect((msg as any).stop_reason).toBe('end_turn');
    expect((msg as any).session_id).toBe('sid');
    expect((msg as any).synthesized).toBe(true);
  });

  it('passes through a real-result node as its raw shape with receivedAt', () => {
    const node: JsonlNode = {
      kind: 'real-result',
      raw: {
        type: 'result',
        subtype: 'success',
        result: 'done',
        is_error: false,
        duration_ms: 1500,
        total_cost_usd: 0.0005,
        stop_reason: 'end_turn',
      } as any,
      sessionId: 'sdk-sid-5',
      receivedAt: '2026-05-24T10:00:01Z',
    };
    const msg = jsonlNodeToStreamMessage(node);
    expect(msg?.type).toBe('result');
    expect((msg as any).subtype).toBe('success');
    expect((msg as any).is_error).toBe(false);
    expect((msg as any).receivedAt).toBe('2026-05-24T10:00:01Z');
    // real results should NOT have the synthesized flag
    expect((msg as any).synthesized).toBeUndefined();
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
