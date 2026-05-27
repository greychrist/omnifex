import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import {
  getTaskList,
  summarizeTaskList,
  type TaskListEntry,
} from '../taskList';

// Build the live-stream shapes the renderer sees under SDK 0.3.x. The
// `taskCreateResultMsg` helper uses the LIVE wire format (content string
// only, no envelope) so attribution + parsing are exercised against the
// real shape end to end. Verified against
// ~/.claude-personal/projects/-Users-gregorychristie-Repos-personal-WIN/
// real session JSONL.

function taskCreateMsg(
  blockId: string,
  input: { subject?: string; description?: string; activeForm?: string },
): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: blockId, name: 'TaskCreate', input }],
        stop_reason: 'tool_use',
      },
    },
  } as unknown as JsonlNode;
}

function taskCreateResultMsg(blockId: string, taskId: string): JsonlNode {
  return {
    kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
    raw: {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: blockId,
          content: `Task #${taskId} created successfully: unused`,
        }],
      },
    },
  } as unknown as JsonlNode;
}

function taskUpdateMsg(
  blockId: string,
  input: { taskId: string; status?: string; subject?: string; activeForm?: string },
): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: blockId, name: 'TaskUpdate', input }],
        stop_reason: 'tool_use',
      },
    },
  } as unknown as JsonlNode;
}

/** A plain assistant text block — the kind of message that should get
 *  attributed to the task that is currently in_progress at the time it
 *  was emitted. */
function assistantText(text: string): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
      },
    },
  } as unknown as JsonlNode;
}

/** An unrelated tool_use (e.g. Read) that should get attributed to the
 *  currently-in_progress task. */
function readToolUse(blockId: string, file: string): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: blockId, name: 'Read', input: { file_path: file } }],
        stop_reason: 'tool_use',
      },
    },
  } as unknown as JsonlNode;
}

describe('getTaskList', () => {
  it('returns null on empty input', () => {
    expect(getTaskList([])).toBeNull();
  });

  it('returns null when no Task* tool_use is present', () => {
    expect(getTaskList([assistantText('hi'), readToolUse('r1', '/a')])).toBeNull();
  });

  it('returns one pending task with no attributed messages after a single TaskCreate', () => {
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'first task' }),
      taskCreateResultMsg('tu1', '1'),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      id: '1',
      subject: 'first task',
      status: 'pending',
      messageIndices: [],
    });
    expect(result?.[0].messages).toEqual([]);
  });

  it('preserves activeForm on a TaskCreate', () => {
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'run tests', activeForm: 'Running tests' }),
      taskCreateResultMsg('tu1', '1'),
    ]);
    expect(result?.[0].activeForm).toBe('Running tests');
  });

  it('preserves creation order across multiple TaskCreates', () => {
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'a' }),
      taskCreateResultMsg('tu1', '1'),
      taskCreateMsg('tu2', { subject: 'b' }),
      taskCreateResultMsg('tu2', '2'),
      taskCreateMsg('tu3', { subject: 'c' }),
      taskCreateResultMsg('tu3', '3'),
    ]);
    expect(result?.map((t) => t.subject)).toEqual(['a', 'b', 'c']);
  });

  it('attributes messages emitted between in_progress and completed to the running task', () => {
    const work1 = assistantText('thinking about the bug');
    const work2 = readToolUse('r1', '/src/auth.ts');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'fix bug' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'in_progress' }),
      work1,
      work2,
      taskUpdateMsg('tu3', { taskId: '1', status: 'completed' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0].status).toBe('completed');
    expect(result?.[0].messages).toEqual([work1, work2]);
    expect(result?.[0].messageIndices).toHaveLength(2);
  });

  it('falls back to earliest non-terminal task when no task is in_progress', () => {
    // Common real-world case: the agent skips the in_progress step and
    // goes TaskCreate → do work → TaskUpdate(completed). Without a
    // fallback every message would be unattributed; the SDK doesn't ship
    // a "this work belongs to that task" signal, so we use the queue
    // ordering: until task #1 completes, work belongs to #1; then to #2;
    // and so on.
    const work = assistantText('working on the fast task');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'fast task' }),
      taskCreateResultMsg('tu1', '1'),
      work,
      taskUpdateMsg('tu2', { taskId: '1', status: 'completed' }),
    ]);
    expect(result?.[0].status).toBe('completed');
    expect(result?.[0].messages).toEqual([work]);
  });

  it('attributes batched-up-front work to the right task by queue order (no in_progress used)', () => {
    // Realistic batched flow: agent creates A, B, C up front, then does
    // work and completes them one by one with no in_progress updates.
    const a1 = assistantText('a-1');
    const a2 = readToolUse('r1', '/a');
    const b1 = assistantText('b-1');
    const c1 = assistantText('c-1');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'A' }),
      taskCreateResultMsg('tu1', '1'),
      taskCreateMsg('tu2', { subject: 'B' }),
      taskCreateResultMsg('tu2', '2'),
      taskCreateMsg('tu3', { subject: 'C' }),
      taskCreateResultMsg('tu3', '3'),
      a1, a2,
      taskUpdateMsg('tu4', { taskId: '1', status: 'completed' }),
      b1,
      taskUpdateMsg('tu5', { taskId: '2', status: 'completed' }),
      c1,
      taskUpdateMsg('tu6', { taskId: '3', status: 'completed' }),
    ]);
    expect(result?.[0].messages).toEqual([a1, a2]);
    expect(result?.[1].messages).toEqual([b1]);
    expect(result?.[2].messages).toEqual([c1]);
  });

  it('prefers an explicit in_progress task over the queue fallback', () => {
    // If the agent DOES use in_progress, that overrides queue order
    // even when the in_progress task is later in the queue.
    const work = assistantText('working out of order');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'A' }),
      taskCreateResultMsg('tu1', '1'),
      taskCreateMsg('tu2', { subject: 'B' }),
      taskCreateResultMsg('tu2', '2'),
      // B explicitly marked in_progress despite A being earlier in queue
      taskUpdateMsg('tu3', { taskId: '2', status: 'in_progress' }),
      work,
      taskUpdateMsg('tu4', { taskId: '2', status: 'completed' }),
    ]);
    // Work should belong to B (in_progress override), not A (queue fallback).
    expect(result?.[0].messages).toEqual([]);          // A
    expect(result?.[1].messages).toEqual([work]);      // B
  });

  it('leaves an in_progress task as in_progress when a turn-level result arrives (no force-complete)', () => {
    // The agent started a task but did not emit TaskUpdate(completed) before
    // the turn ended. Previously the `result` event force-completed it, but
    // that behavior broke multi-turn subagents. Now the task stays in_progress
    // and the UI reflects the actual agent state rather than a synthetic guess.
    const work = assistantText('working on it');
    const resultMsg = {
      kind: 'unknown', sessionId: '', receivedAt: '',
      raw: { type: 'result', subtype: 'success', result: 'all done' },
    } as unknown as JsonlNode;
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'finish this' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'in_progress' }),
      work,
      resultMsg,
    ]);
    expect(result?.[0].status).toBe('in_progress');
  });

  it('leaves a pending task as pending when a turn-level result arrives (no force-complete)', () => {
    // Queue-fallback case: agent never used in_progress, just batched
    // TaskCreates and TaskUpdate(completed)d one by one. Previously the
    // `result` event force-completed any remaining tasks, but that broke
    // multi-turn subagents. Now task B correctly stays pending — it reflects
    // actual agent state rather than a synthetic guess.
    const work = assistantText('did the work for the last one');
    const resultMsg = { kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: '' } } as unknown as JsonlNode;
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'A' }),
      taskCreateResultMsg('tu1', '1'),
      taskCreateMsg('tu2', { subject: 'B' }),
      taskCreateResultMsg('tu2', '2'),
      taskUpdateMsg('tu3', { taskId: '1', status: 'completed' }),
      // B becomes the queue head, accumulates `work`, but never gets
      // an explicit TaskUpdate(completed) before the turn ends.
      work,
      resultMsg,
    ]);
    expect(result?.map((t) => t.status)).toEqual(['completed', 'pending']);
  });

  it('leaves a never-touched pending task as pending when a turn-level result arrives', () => {
    // Previously treated as abandoned-or-forgotten and force-completed, but
    // that broke multi-turn subagents. A pending task stays pending — the
    // summarizer's `running: true` correctly keeps the indicator lit, and
    // subsequent turns' TaskUpdate(completed) are the canonical signal.
    const resultMsg = { kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: '' } } as unknown as JsonlNode;
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'never touched' }),
      taskCreateResultMsg('tu1', '1'),
      resultMsg,
    ]);
    expect(result?.[0].status).toBe('pending');
  });

  it('drops the prior batch and shows only the new post-result batch as mid-flight', () => {
    // A previous turn ended (result fired) with one completed task,
    // then the user sent another prompt and the agent created a fresh
    // task. The new task hasn't been worked on yet — it should appear
    // pending on its own, with the old batch cleared from the visible
    // list (matches the "new list empties the old" epoch-boundary UX).
    const oldResult = { kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: '' } } as unknown as JsonlNode;
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'finished long ago' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'completed' }),
      oldResult,
      taskCreateMsg('tu3', { subject: 'mid-flight new task' }),
      taskCreateResultMsg('tu3', '2'),
    ]);
    expect(result?.map((t) => t.subject)).toEqual(['mid-flight new task']);
    expect(result?.[0].status).toBe('pending');
  });

  it('does NOT epoch-reset when a result arrives with a pending task still in the batch', () => {
    // Previously, the result force-completed "untouched" and then the next
    // TaskCreate triggered an epoch-reset (seeing all-completed). Without
    // force-completion, "untouched" stays pending, so the next TaskCreate
    // is additive (not a reset) — both tasks appear in the final list.
    // This is the CORRECT behavior: the pending task from the previous turn
    // is still unfinished and should remain visible.
    const oldResult = { kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: '' } } as unknown as JsonlNode;
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'untouched' }),
      taskCreateResultMsg('tu1', '1'),
      oldResult,
      taskCreateMsg('tu2', { subject: 'fresh start' }),
      taskCreateResultMsg('tu2', '2'),
    ]);
    expect(result?.map((t) => t.subject)).toEqual(['untouched', 'fresh start']);
    expect(result?.[0].status).toBe('pending');
    expect(result?.[1].status).toBe('pending');
  });

  it('leaves in_progress tasks alone when no result message has fired yet', () => {
    // Mid-turn — the agent is genuinely still working. No inference.
    const work = assistantText('still going');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'in flight' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'in_progress' }),
      work,
    ]);
    expect(result?.[0].status).toBe('in_progress');
  });

  it('stops attributing once every task is terminal', () => {
    const between = assistantText('a comment with nothing to attribute to');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'A' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'completed' }),
      between,
    ]);
    expect(result?.[0].messages).toEqual([]);
  });

  it('switches attribution when one task completes and another goes in_progress', () => {
    const aWork = assistantText('working on A');
    const bWork = assistantText('working on B');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'task A' }),
      taskCreateResultMsg('tu1', '1'),
      taskCreateMsg('tu2', { subject: 'task B' }),
      taskCreateResultMsg('tu2', '2'),
      taskUpdateMsg('tu3', { taskId: '1', status: 'in_progress' }),
      aWork,
      taskUpdateMsg('tu4', { taskId: '1', status: 'completed' }),
      taskUpdateMsg('tu5', { taskId: '2', status: 'in_progress' }),
      bWork,
      taskUpdateMsg('tu6', { taskId: '2', status: 'completed' }),
    ]);
    expect(result?.[0].messages).toEqual([aWork]);
    expect(result?.[1].messages).toEqual([bWork]);
  });

  it('attributes nothing once the running task completes, until a new one starts', () => {
    const between = assistantText('a comment between tasks');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'A' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'in_progress' }),
      taskUpdateMsg('tu3', { taskId: '1', status: 'completed' }),
      between,
    ]);
    expect(result?.[0].messages).toEqual([]);
  });

  it('does NOT attribute the TaskCreate / TaskUpdate tool_uses themselves to a task row', () => {
    // The Task* tool_uses drive the state machine; rendering them as
    // attributed messages would create noisy meta-rows about the system
    // managing itself.
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'A' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'in_progress' }),
      taskCreateMsg('tu3', { subject: 'B' }),         // emitted during A's window
      taskCreateResultMsg('tu3', '2'),                // result for B
      taskUpdateMsg('tu4', { taskId: '1', status: 'completed' }),
    ]);
    expect(result?.[0].subject).toBe('A');
    expect(result?.[0].messages).toEqual([]);
    expect(result?.[1].subject).toBe('B');
  });

  it('drops a task entirely when TaskUpdate marks it deleted, along with any attributed messages', () => {
    const drop = assistantText('this should not appear anywhere');
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'keep' }),
      taskCreateResultMsg('tu1', '1'),
      taskCreateMsg('tu2', { subject: 'drop' }),
      taskCreateResultMsg('tu2', '2'),
      taskUpdateMsg('tu3', { taskId: '2', status: 'in_progress' }),
      drop,
      taskUpdateMsg('tu4', { taskId: '2', status: 'deleted' }),
    ]);
    expect(result?.map((t) => t.subject)).toEqual(['keep']);
    expect(result?.[0].messages).toEqual([]);
  });

  it('starts a fresh list when a TaskCreate fires after all prior tasks are completed', () => {
    // Matches the old TodoBar's UX: when the agent finishes a batch of
    // todos and then starts a new batch, the new list replaces the old
    // rather than appending. Detection: a TaskCreate that arrives when
    // every existing task is in `completed`.
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'old A' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'in_progress' }),
      taskUpdateMsg('tu3', { taskId: '1', status: 'completed' }),
      taskCreateMsg('tu4', { subject: 'new B' }),
      taskCreateResultMsg('tu4', '2'),
    ]);
    expect(result?.map((t) => t.subject)).toEqual(['new B']);
    expect(result?.[0].status).toBe('pending');
  });

  it('does NOT reset when a TaskCreate fires while another task is still in flight', () => {
    // A pending or in_progress task means the agent isn't done with the
    // current batch — a new TaskCreate is appended, not a fresh start.
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'A' }),
      taskCreateResultMsg('tu1', '1'),
      taskCreateMsg('tu2', { subject: 'B' }),
      taskCreateResultMsg('tu2', '2'),
      taskUpdateMsg('tu3', { taskId: '1', status: 'in_progress' }),
      taskUpdateMsg('tu4', { taskId: '1', status: 'completed' }),
      // B is still pending → C is part of the same batch.
      taskCreateMsg('tu5', { subject: 'C' }),
      taskCreateResultMsg('tu5', '3'),
    ]);
    expect(result?.map((t) => t.subject)).toEqual(['A', 'B', 'C']);
  });

  it('resets repeatedly across several completed-then-new batches', () => {
    // Each fully-completed batch yields to the next TaskCreate that arrives.
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'batch1.A' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', status: 'completed' }),
      taskCreateMsg('tu3', { subject: 'batch2.A' }),
      taskCreateResultMsg('tu3', '2'),
      taskUpdateMsg('tu4', { taskId: '2', status: 'completed' }),
      taskCreateMsg('tu5', { subject: 'batch3.A' }),
      taskCreateResultMsg('tu5', '3'),
    ]);
    expect(result?.map((t) => t.subject)).toEqual(['batch3.A']);
  });

  it('honors a TaskUpdate that renames the subject mid-flight', () => {
    const result = getTaskList([
      taskCreateMsg('tu1', { subject: 'original' }),
      taskCreateResultMsg('tu1', '1'),
      taskUpdateMsg('tu2', { taskId: '1', subject: 'renamed' }),
    ]);
    expect(result?.[0].subject).toBe('renamed');
  });

  it('does NOT force-complete pending tasks when a turn-level result event lands', () => {
    // Constructed sequence mirroring real agent behavior:
    //  - TaskCreate creates 3 tasks (T1, T2, T3) → pending
    //  - TaskUpdate marks T1 completed
    //  - A `result` message arrives (as cli-stream-result after Task 7 refactor)
    //  - T2 and T3 should REMAIN pending (the agent hasn't done them yet)
    const messages = [
      taskCreateMsg('tu1', { subject: 'T1' }),
      taskCreateResultMsg('tu1', 'task-1'),
      taskCreateMsg('tu2', { subject: 'T2' }),
      taskCreateResultMsg('tu2', 'task-2'),
      taskCreateMsg('tu3', { subject: 'T3' }),
      taskCreateResultMsg('tu3', 'task-3'),
      taskUpdateMsg('tu4', { taskId: 'task-1', status: 'completed' }),
      // Turn-level result lands as cli-stream-result (engine-mode pipeline)
      { kind: 'cli-stream-result', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'ok', is_error: false } } as unknown as JsonlNode,
    ];

    const tasks = getTaskList(messages);
    expect(tasks).not.toBeNull();
    const byId = new Map(tasks!.map((t) => [t.id, t]));
    expect(byId.get('task-1')?.status).toBe('completed');
    expect(byId.get('task-2')?.status).toBe('pending');
    expect(byId.get('task-3')?.status).toBe('pending');
  });
});

describe('summarizeTaskList', () => {
  function entry(status: TaskListEntry['status']): TaskListEntry {
    return { id: 'x', subject: 's', status, messages: [], messageIndices: [] };
  }

  it('counts done / in_progress / pending across the list', () => {
    expect(summarizeTaskList([
      entry('completed'),
      entry('completed'),
      entry('in_progress'),
      entry('pending'),
      entry('pending'),
    ])).toEqual({
      total: 5,
      done: 2,
      inProgress: 1,
      pending: 2,
      running: true,
    });
  });

  it('reports running=false when everything is completed', () => {
    expect(summarizeTaskList([entry('completed'), entry('completed')])).toEqual({
      total: 2, done: 2, inProgress: 0, pending: 0, running: false,
    });
  });

  it('reports running=true when only pending items remain', () => {
    expect(summarizeTaskList([entry('pending')])).toEqual({
      total: 1, done: 0, inProgress: 0, pending: 1, running: true,
    });
  });

  it('handles an empty list', () => {
    expect(summarizeTaskList([])).toEqual({
      total: 0, done: 0, inProgress: 0, pending: 0, running: false,
    });
  });
});
