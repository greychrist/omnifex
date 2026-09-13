import { describe, it, expect } from 'vitest';
import {
  reduceToolProgress,
  pruneToolProgress,
  anchorToolUseId,
  EMPTY_TOOL_PROGRESS,
  type ToolProgressNode,
} from '../toolProgress';

function beat(id: string, elapsed: number, parent: string | null = null): ToolProgressNode {
  return {
    kind: 'tool-progress',
    anchorToolUseId: anchorToolUseId(id),
    raw: {
      type: 'tool_progress',
      tool_use_id: id,
      tool_name: 'Bash',
      parent_tool_use_id: parent,
      elapsed_time_seconds: elapsed,
      heartbeat: true,
    },
  };
}

function retryFrame(attempt: number): ToolProgressNode {
  return {
    kind: 'tool-progress',
    anchorToolUseId: 'toolu_TASK',
    raw: {
      type: 'tool_progress',
      tool_use_id: 'toolu_TASK',
      tool_name: 'Task',
      parent_tool_use_id: null,
      elapsed_time_seconds: 0,
      subagent_type: 'Explore',
      subagent_retry: {
        agent_id: 'a1',
        attempt,
        max_retries: 3,
        retry_delay_ms: 1500,
        error_status: 529,
        error_category: 'overloaded_error',
      },
    },
  };
}

const resolvedFrame: ToolProgressNode = {
  kind: 'tool-progress',
  anchorToolUseId: 'toolu_TASK',
  raw: {
    type: 'tool_progress',
    tool_use_id: 'toolu_TASK',
    tool_name: 'Task',
    parent_tool_use_id: null,
    elapsed_time_seconds: 0,
    subagent_type: 'Explore',
  },
};

describe('anchorToolUseId', () => {
  it('strips the synthetic heartbeat suffix', () => {
    expect(anchorToolUseId('toolu_01AAA-heartbeat-0')).toBe('toolu_01AAA');
    expect(anchorToolUseId('toolu_01AAA-heartbeat-17')).toBe('toolu_01AAA');
  });

  it('leaves a plain tool id alone', () => {
    expect(anchorToolUseId('toolu_01AAA')).toBe('toolu_01AAA');
  });

  it('does not strip a trailing hyphen-number that is not a heartbeat', () => {
    expect(anchorToolUseId('toolu_01AAA-retry-2')).toBe('toolu_01AAA-retry-2');
  });
});

describe('reduceToolProgress', () => {
  it('keys the entry by the real tool id, not the heartbeat id', () => {
    const next = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    expect([...next.keys()]).toEqual(['toolu_01AAA']);
    expect(next.get('toolu_01AAA')).toEqual({
      elapsedSeconds: 30,
      arrivedAtMs: 1000,
      retry: null,
    });
  });

  it('ignores parent_tool_use_id even when it names a different tool', () => {
    // A Bash running inside a subagent: the parent is the Task id, not the
    // Bash id, so anchoring on it would file the progress under the wrong row.
    const next = reduceToolProgress(
      EMPTY_TOOL_PROGRESS,
      beat('toolu_BASH-heartbeat-1', 60, 'toolu_TASK'),
      2000,
    );
    expect([...next.keys()]).toEqual(['toolu_BASH']);
  });

  it('is idempotent — the same frame twice yields an equal map', () => {
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    const b = reduceToolProgress(a, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    expect(b.get('toolu_01AAA')).toEqual(a.get('toolu_01AAA'));
  });

  it('returns the SAME reference when nothing moved', () => {
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    const b = reduceToolProgress(a, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    expect(b).toBe(a);
  });

  it('does not mutate the previous map', () => {
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    reduceToolProgress(a, beat('toolu_01AAA-heartbeat-1', 60), 2000);
    expect(a.get('toolu_01AAA')?.elapsedSeconds).toBe(30);
  });

  it('advances elapsed and arrival on a later beat', () => {
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_01AAA-heartbeat-0', 30), 1000);
    const b = reduceToolProgress(a, beat('toolu_01AAA-heartbeat-1', 60), 31_000);
    expect(b.get('toolu_01AAA')).toEqual({
      elapsedSeconds: 60,
      arrivedAtMs: 31_000,
      retry: null,
    });
  });

  it('tracks two tools independently', () => {
    let m = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_A-heartbeat-0', 30), 1000);
    m = reduceToolProgress(m, beat('toolu_B-heartbeat-0', 90), 1000);
    expect(m.get('toolu_A')?.elapsedSeconds).toBe(30);
    expect(m.get('toolu_B')?.elapsedSeconds).toBe(90);
  });

  it('records a subagent retry', () => {
    const next = reduceToolProgress(EMPTY_TOOL_PROGRESS, retryFrame(2), 1000);
    expect(next.get('toolu_TASK')?.retry).toEqual({
      attempt: 2,
      maxRetries: 3,
      retryDelayMs: 1500,
      errorStatus: 529,
      errorCategory: 'overloaded_error',
    });
  });

  it('clears the retry when a resolved frame arrives (subagent_retry absent)', () => {
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, retryFrame(2), 1000);
    const b = reduceToolProgress(a, resolvedFrame, 2000);
    expect(b.get('toolu_TASK')?.retry).toBeNull();
  });

  it('a heartbeat does not clear an open retry', () => {
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, retryFrame(1), 1000);
    const b = reduceToolProgress(a, beat('toolu_TASK-heartbeat-0', 30), 2000);
    expect(b.get('toolu_TASK')?.retry?.attempt).toBe(1);
    expect(b.get('toolu_TASK')?.elapsedSeconds).toBe(30);
  });

  it('keeps the same reference when a resolved frame repeats', () => {
    const a = reduceToolProgress(EMPTY_TOOL_PROGRESS, resolvedFrame, 1000);
    const b = reduceToolProgress(a, resolvedFrame, 1000);
    expect(b).toBe(a);
  });
});

describe('pruneToolProgress', () => {
  it('drops every key not in the keep set', () => {
    let m = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_A-heartbeat-0', 30), 1000);
    m = reduceToolProgress(m, beat('toolu_B-heartbeat-0', 30), 1000);
    expect([...pruneToolProgress(m, new Set(['toolu_A'])).keys()]).toEqual(['toolu_A']);
  });

  it('returns the same reference when nothing is dropped', () => {
    const m = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_A-heartbeat-0', 30), 1000);
    expect(pruneToolProgress(m, new Set(['toolu_A']))).toBe(m);
  });

  it('empties the map for an empty keep set', () => {
    const m = reduceToolProgress(EMPTY_TOOL_PROGRESS, beat('toolu_A-heartbeat-0', 30), 1000);
    expect(pruneToolProgress(m, new Set()).size).toBe(0);
  });

  it('returns the same reference when the map is already empty', () => {
    expect(pruneToolProgress(EMPTY_TOOL_PROGRESS, new Set())).toBe(EMPTY_TOOL_PROGRESS);
  });
});
