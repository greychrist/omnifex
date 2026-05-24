import { describe, it, expect } from 'vitest';
import { createSynthesizer, synthesizeBatch } from '../jsonlSynthesizer';
import type { JsonlNode } from '@/types/jsonl';

function assistantNode(stopReason: string | null, ts = '2026-05-24T10:00:00Z'): JsonlNode {
  return {
    kind: 'assistant',
    raw: {
      type: 'assistant',
      sessionId: 'sid-1',
      timestamp: ts,
      cwd: '/Users/test/proj',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'final answer' }],
        stop_reason: stopReason,
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'claude-opus-4-7',
      },
    } as any,
    sessionId: 'sid-1',
    receivedAt: ts,
  };
}

function userPromptNode(ts = '2026-05-24T09:59:30Z'): JsonlNode {
  return {
    kind: 'user',
    raw: {
      type: 'user',
      sessionId: 'sid-1',
      timestamp: ts,
      cwd: '/Users/test/proj',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'a prompt' }],
      },
    } as any,
    sessionId: 'sid-1',
    receivedAt: ts,
    userKind: 'prompt',
  };
}

describe('createSynthesizer', () => {
  it('emits synthesized-init once for the first sessioned node', () => {
    const s = createSynthesizer();
    const out1 = s.push(userPromptNode());
    expect(out1.map(n => n.kind)).toEqual(['synthesized-init', 'user']);
    const out2 = s.push(assistantNode('tool_use'));
    expect(out2.map(n => n.kind)).toEqual(['assistant']);
  });

  it('emits synthesized-result after assistant with terminal stop_reason', () => {
    const s = createSynthesizer();
    s.push(userPromptNode('2026-05-24T09:59:30Z'));
    const out = s.push(assistantNode('end_turn', '2026-05-24T10:00:00Z'));
    expect(out.map(n => n.kind)).toEqual(['assistant', 'synthesized-result']);
    const result = out[1];
    if (result.kind === 'synthesized-result') {
      expect(result.isError).toBe(false);
      expect(result.subtype).toBe('success');
      expect(result.stopReason).toBe('end_turn');
      expect(result.durationMs).toBe(30000); // 30s between prompt and reply
      expect(result.usage.input_tokens).toBe(100);
    }
  });

  it('emits synthesized-result with error subtype for max_tokens', () => {
    const s = createSynthesizer();
    s.push(userPromptNode());
    const out = s.push(assistantNode('max_tokens'));
    const result = out[1];
    if (result.kind === 'synthesized-result') {
      expect(result.isError).toBe(true);
      expect(result.subtype).toBe('error_during_execution');
    }
  });

  it('does NOT emit synthesized-result for tool_use stop_reason', () => {
    const s = createSynthesizer();
    s.push(userPromptNode());
    const out = s.push(assistantNode('tool_use'));
    expect(out.map(n => n.kind)).toEqual(['assistant']);
  });

  it('flush() emits synthesized-result for an unterminated turn', () => {
    const s = createSynthesizer();
    s.push(userPromptNode());
    s.push(assistantNode(null)); // partial, no stop_reason
    const flushed = s.flush();
    expect(flushed.map(n => n.kind)).toEqual(['synthesized-result']);
    if (flushed[0].kind === 'synthesized-result') {
      expect(flushed[0].isError).toBe(true);
    }
  });

  it('flush() is a no-op when the last turn ended cleanly', () => {
    const s = createSynthesizer();
    s.push(userPromptNode());
    s.push(assistantNode('end_turn'));
    expect(s.flush()).toEqual([]);
  });
});

describe('synthesizeBatch', () => {
  it('produces the same output for a complete sequence', () => {
    const nodes: JsonlNode[] = [
      userPromptNode('2026-05-24T09:59:30Z'),
      assistantNode('end_turn', '2026-05-24T10:00:00Z'),
    ];
    const out = synthesizeBatch(nodes);
    expect(out.map(n => n.kind)).toEqual([
      'synthesized-init',
      'user',
      'assistant',
      'synthesized-result',
    ]);
  });
});
