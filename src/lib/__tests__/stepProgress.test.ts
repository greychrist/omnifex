import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import type { Subagent } from '../subagentStreams';
import {
  PROGRESS_TOOL,
  latestMainProgress,
  latestSubagentProgress,
  parseProgressInput,
  withStepProgress,
} from '../stepProgress';

function progressCall(input: unknown, forwarded?: { parent: string; agentId?: string }): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      ...(forwarded ? { parent_tool_use_id: forwarded.parent, ...(forwarded.agentId ? { agent_id: forwarded.agentId } : {}) } : {}),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${Math.random()}`, name: PROGRESS_TOOL, input }] },
    },
  } as unknown as JsonlNode;
}

function prompt(text = 'go'): JsonlNode {
  return {
    kind: 'user', sessionId: '', receivedAt: '', userKind: 'prompt',
    raw: { type: 'user', message: { role: 'user', content: text } },
  } as unknown as JsonlNode;
}

function row(toolUseId: string, extra: Partial<Subagent> = {}): Subagent {
  return { toolUseId, description: 'd', status: 'running', latest: null, events: [], colorIndex: 0, ...extra };
}

describe('parseProgressInput', () => {
  it('reads done, total and a note', () => {
    expect(parseProgressInput({ done: 2, total: 5, note: 'Read x' })).toEqual({ done: 2, total: 5, note: 'Read x' });
  });

  it('rejects a total that is missing, zero, negative, not finite or not a number', () => {
    for (const total of [undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
      expect(parseProgressInput({ done: 1, total })).toBeNull();
    }
    expect(parseProgressInput(null)).toBeNull();
    expect(parseProgressInput('2/5')).toBeNull();
  });

  it('clamps done into 0..total and treats a non-number done as 0', () => {
    expect(parseProgressInput({ done: 9, total: 4 })).toEqual({ done: 4, total: 4 });
    expect(parseProgressInput({ done: -1, total: 4 })).toEqual({ done: 0, total: 4 });
    expect(parseProgressInput({ done: 'x', total: 4 })).toEqual({ done: 0, total: 4 });
  });

  it('drops a blank note', () => {
    expect(parseProgressInput({ done: 1, total: 2, note: '  ' })).toEqual({ done: 1, total: 2 });
  });
});

describe('latestSubagentProgress', () => {
  it('keeps the last call per agent, keyed by dispatch and by agent id', () => {
    const p = latestSubagentProgress([
      progressCall({ done: 0, total: 6 }, { parent: 'toolu_A', agentId: 'agA' }),
      progressCall({ done: 1, total: 3 }, { parent: 'toolu_B' }),
      progressCall({ done: 4, total: 6, note: 'Read y' }, { parent: 'toolu_A', agentId: 'agA' }),
    ]);
    expect(p.byToolUseId).toEqual({ toolu_A: { done: 4, total: 6, note: 'Read y' }, toolu_B: { done: 1, total: 3 } });
    expect(p.byAgentId).toEqual({ agA: { done: 4, total: 6, note: 'Read y' } });
  });

  it('ignores the main session and malformed calls', () => {
    const p = latestSubagentProgress([
      progressCall({ done: 1, total: 2 }),
      progressCall({ done: 1, total: 0 }, { parent: 'toolu_A' }),
    ]);
    expect(p).toEqual({ byToolUseId: {}, byAgentId: {} });
  });
});

describe('latestMainProgress', () => {
  it('is the main session\'s last call in the current turn', () => {
    expect(latestMainProgress([
      prompt(),
      progressCall({ done: 0, total: 3 }),
      progressCall({ done: 1, total: 3, note: 'a' }),
      progressCall({ done: 5, total: 9 }, { parent: 'toolu_A' }),
    ])).toEqual({ done: 1, total: 3, note: 'a' });
  });

  it('starts over at each prompt', () => {
    expect(latestMainProgress([prompt(), progressCall({ done: 3, total: 3 }), prompt()])).toBeNull();
  });

  it('is null when nothing was reported', () => {
    expect(latestMainProgress([prompt()])).toBeNull();
  });
});

describe('withStepProgress', () => {
  it('sets each row\'s progress by its dispatch, falling back to its agent id', () => {
    const [a, nested] = withStepProgress(
      [row('toolu_A'), row('toolu_nested', { taskId: 'agN' })],
      { byToolUseId: { toolu_A: { done: 1, total: 2 } }, byAgentId: { agN: { done: 3, total: 4 } } },
    );
    expect(a.stepProgress).toEqual({ done: 1, total: 2 });
    expect(nested.stepProgress).toEqual({ done: 3, total: 4 });
  });

  it('returns the same rows when nothing reported, so memoised children do not re-render', () => {
    const rows = [row('toolu_A')];
    expect(withStepProgress(rows, { byToolUseId: {}, byAgentId: {} })).toBe(rows);
  });
});
